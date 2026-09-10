import type { Provider } from './types';
import type { AsrProviderConfig, AsrProviderId } from './asrProviders';
import type { ResolvedEngine } from './modelRouting';
import { serviceTranslateText } from './translateServices';
import { transcribeAudio, isAsrReady } from './asrClient';
import { addTurn, createSession, endSession, saveRecording } from './localDb';
import { localModelRequest, modelError, trimBaseUrl } from './modelClient';
import { recordActivity } from './activityLog';

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

export type InterpretationLine = {
  key: string;
  source: string;
  target: string;
  time: string;
  pending?: boolean;
  offsetMs?: number;
};

const SR = (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike });

export const speechRecognitionAvailable = Boolean(SR.SpeechRecognition || SR.webkitSpeechRecognition);

/** Windows、Edge、Safari 支持的录音封装各不相同，按优先级挑一个当前浏览器可用的 */
function pickRecorderMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const candidate of candidates) {
    try { if (MediaRecorder.isTypeSupported(candidate)) return candidate; } catch { /* 探测失败则继续 */ }
  }
  return '';
}

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return minutes + ':' + String(seconds).padStart(2, '0');
}

/** 云端语音识别的运行配置，由设置里的"语音识别"页生成 */
export type CloudAsrConfig = {
  providerId: AsrProviderId;
  preset: AsrProviderConfig;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  language: string;
};

export class InterpretationEngine {
  private recognition: SpeechRecognitionLike | null = null;
  private recorder: MediaRecorder | null = null;
  private recordingChunks: Blob[] = [];
  private segmentRecorder: MediaRecorder | null = null;
  private segmentChunks: Blob[] = [];
  private segmentQueue: Promise<void> = Promise.resolve();
  private stream: MediaStream | null = null;
  private restarted = false;
  private fatalAsr = false;
  private restartCount = 0;
  private lastRecognitionStart = 0;
  private utteranceStart: number | null = null;
  private sessionId: number | null = null;
  private startedAt = 0;
  private analysing: AnalyserNode | null = null;
  private audioContext: AudioContext | null = null;
  private raf = 0;
  private asrTimer = 0;
  private stopping = false;
  private translations = new Set<Promise<void>>();
  private onStatus: (status: 'listening' | 'error', message?: string) => void = () => undefined;
  private readonly chunkIntervalMs: number;
  private readonly cloud: CloudAsrConfig | null;
  private readonly engine: ResolvedEngine | null;
  private readonly targetLanguage: string;
  onLine: (line: InterpretationLine) => void = () => undefined;
  onDraft: (text: string) => void = () => undefined;

  constructor(cloud: CloudAsrConfig | null, engine: ResolvedEngine | null, targetLanguage: string, chunkIntervalMs = 0) {
    this.cloud = cloud;
    this.engine = engine;
    this.targetLanguage = targetLanguage;
    this.chunkIntervalMs = chunkIntervalMs || cloud?.preset.chunkIntervalMs || 0;
  }

  onLevel: ((level: number) => void) | null = null;

  async start(sourceLanguage: string, onStatus: (status: 'listening' | 'error', message?: string) => void, deviceId?: string): Promise<void> {
    if (this.cloud && !isAsrReady(this.cloud)) {
      throw new Error('asr-not-ready');
    }
    if (!this.cloud && !speechRecognitionAvailable) {
      throw new Error('当前浏览器不支持语音识别，请使用 Chrome 或 Edge');
    }
    this.startedAt = Date.now();
    this.restarted = false;
    this.stopping = false;
    this.onStatus = onStatus;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true
      });
    }
    catch (error) {
      const name = (error as DOMException | undefined)?.name || '';
      if (!navigator.mediaDevices) onStatus('error', '当前页面不是安全上下文，请通过桌面启动入口打开 Parallel');
      else if (name === 'NotAllowedError' || name === 'SecurityError') onStatus('error', '麦克风权限被拒绝，请在浏览器地址栏的权限设置里允许');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') onStatus('error', '没有找到可用的麦克风，请检查系统输入设备');
      else onStatus('error', '无法访问麦克风，请在浏览器设置中允许');
      throw new Error('microphone');
    }
    this.sessionId = await createSession(sourceLanguage, this.targetLanguage);
    this.startedAt = Date.now();
    this.recordingChunks = [];
    const mimeType = pickRecorderMime();
    try { this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined); }
    catch { this.recorder = null; }
    if (this.recorder) {
      this.recorder.ondataavailable = event => { if (event.data.size) this.recordingChunks.push(event.data); };
      this.recorder.start(1000);
    }
    if (this.cloud) {
      this.startSegmentRecorder();
      this.asrTimer = window.setInterval(() => this.rotateSegment(), this.chunkIntervalMs || 5000);
    } else {
      this.fatalAsr = false;
      this.restartCount = 0;
      this.startBrowserRecognition(sourceLanguage, onStatus);
    }
    this.startMeter();
    onStatus('listening');
  }

  private startBrowserRecognition(sourceLanguage: string, onStatus: (status: 'listening' | 'error', message?: string) => void): void {
    const Recognition = (SR.SpeechRecognition || SR.webkitSpeechRecognition) as new () => SpeechRecognitionLike;
    const recognition = new Recognition();
    recognition.lang = sourceLanguage === '简体中文' ? 'zh-CN' : 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = event => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript || '';
        if (!transcript.trim()) continue;
        this.utteranceStart ??= Date.now() - this.startedAt;
        if (result.isFinal) {
          this.onDraft('');
          const line: InterpretationLine = {
            key: 'line-' + Date.now() + '-' + index,
            source: transcript.trim(),
            target: '',
            time: formatClock(Date.now() - this.startedAt),
            offsetMs: this.utteranceStart,
            pending: true
          };
          this.onLine(line);
          this.utteranceStart = null;
          this.queueTranslation(line);
        } else this.onDraft(transcript.trim());
      }
    };
    recognition.onerror = event => {
      const kind = event.error || '';
      if (!kind || kind === 'aborted' || kind === 'no-speech') return;
      if (kind === 'network') {
        this.fatalAsr = true;
        recordActivity({ scope: 'speech', stage: '同声传译', action: '浏览器识别', status: 'error', detail: 'Web Speech API 连接识别服务失败' });
        onStatus('error', '浏览器识别服务连不上（国内网络常见）。录音仍在保存；可到 设置 → 语音识别 改用云服务商');
        return;
      }
      if (kind === 'not-allowed' || kind === 'service-not-allowed') {
        this.fatalAsr = true;
        onStatus('error', '浏览器识别权限被拒绝，请在浏览器地址栏允许麦克风后重试');
        return;
      }
      if (kind === 'audio-capture') {
        this.fatalAsr = true;
        onStatus('error', '没有可用的麦克风设备');
        return;
      }
      onStatus('error', '识别暂时中断，正在自动恢复');
    };
    recognition.onend = () => {
      if (this.fatalAsr || this.restarted || this.recognition !== recognition) return;
      if (Date.now() - this.lastRecognitionStart < 2000) {
        this.restartCount += 1;
        if (this.restartCount >= 3) {
          this.fatalAsr = true;
          onStatus('error', '浏览器识别多次启动失败，已停止自动重试。可到 设置 → 语音识别 改用云服务商');
          return;
        }
      } else this.restartCount = 0;
      window.setTimeout(() => {
        if (this.fatalAsr || this.restarted || this.recognition !== recognition) return;
        try { recognition.start(); this.lastRecognitionStart = Date.now(); } catch { /* 识别已停止 */ }
      }, 300);
    };
    this.recognition = recognition;
    this.lastRecognitionStart = Date.now();
    recognition.start();
  }

  private startSegmentRecorder(): void {
    if (!this.stream || this.stopping || !this.cloud) return;
    this.segmentChunks = [];
    const mimeType = pickRecorderMime();
    try { this.segmentRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined); }
    catch {
      this.segmentRecorder = null;
      this.onStatus('error', '录音分段初始化失败，云端识别无法进行，请退出应用后重新打开');
      return;
    }
    const recorder = this.segmentRecorder;
    const offsetMs = Date.now() - this.startedAt;
    recorder.ondataavailable = event => { if (event.data.size) this.segmentChunks.push(event.data); };
    recorder.onstop = () => {
      const blob = new Blob(this.segmentChunks, { type: recorder.mimeType || 'audio/webm' });
      this.segmentChunks = [];
      if (blob.size > 0) this.segmentQueue = this.segmentQueue.then(() => this.transcribeSegment(blob, offsetMs));
      if (!this.stopping) this.startSegmentRecorder();
    };
    recorder.start();
  }

  private rotateSegment(): void {
    const recorder = this.segmentRecorder;
    if (!recorder || recorder.state === 'inactive') return;
    try { recorder.stop(); } catch { /* 分段已结束 */ }
  }

  private async transcribeSegment(blob: Blob, offsetMs: number): Promise<void> {
    if (!this.cloud) return;
    try {
      const text = (await transcribeAudio(blob, this.cloud)).trim();
      if (text) {
        recordActivity({ scope: 'speech', stage: '同声传译', action: '云端语音识别', status: 'success', outputPreview: text.slice(0, 120) });
        const line: InterpretationLine = {
          key: 'line-' + Date.now(),
          source: text,
          target: '',
          time: formatClock(offsetMs),
          offsetMs,
          pending: true
        };
        this.onLine(line);
        this.queueTranslation(line);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '未知错误');
      recordActivity({ scope: 'speech', stage: '同声传译', action: '云端语音识别', status: 'error', detail: message.slice(0, 300) });
      this.onStatus('error', '语音识别失败：' + message.slice(0, 120) + '。录音仍在继续');
    }
  }

  private queueTranslation(line: InterpretationLine): void {
    const task = this.translate(line);
    this.translations.add(task);
    void task.finally(() => this.translations.delete(task));
  }

  private async translate(line: InterpretationLine): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId !== null) {
      try { await addTurn(sessionId, 'source', line.source, line.offsetMs || 0); }
      catch { this.onStatus('error', '识别文字保存失败，请检查本地磁盘空间'); }
    }
    let target = '';
    if (this.engine?.kind === 'model') {
      try {
        target = await translateText(line.source, this.engine.provider, this.targetLanguage);
      } catch {
        target = '（这句翻译失败了，稍后的内容不受影响）';
      }
    } else if (this.engine?.kind === 'service') {
      try {
        target = await serviceTranslateText(line.source, this.engine.serviceId, this.engine.config, this.targetLanguage);
      } catch {
        target = '（这句翻译失败了，稍后的内容不受影响）';
      }
    } else {
      target = '（先在设置中选择翻译引擎，才能自动翻译）';
    }
    this.onLine({ ...line, target, pending: false });
    if (sessionId !== null) {
      try {
        await addTurn(sessionId, 'target', target, line.offsetMs || 0);
      } catch { this.onStatus('error', '译文保存失败，请检查本地磁盘空间'); }
    }
  }

  private startMeter(): void {
    if (!this.stream) return;
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new Ctx();
      void this.audioContext.resume().catch(() => undefined);
      const source = this.audioContext.createMediaStreamSource(this.stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.analysing = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!this.analysing) return;
        this.analysing.getByteTimeDomainData(data);
        let sum = 0;
        for (let index = 0; index < data.length; index += 1) { const value = (data[index] - 128) / 128; sum += value * value; }
        this.onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 4));
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* 音量可视化失败不影响录音 */ }
  }

  private stopMeter(): void {
    this.analysing = null;
    cancelAnimationFrame(this.raf);
    this.onLevel?.(0);
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.restarted = true;
    this.stopMeter();
    window.clearInterval(this.asrTimer);
    this.asrTimer = 0;
    this.onDraft('');
    try { this.recognition?.stop(); } catch { /* 已停止 */ }
    this.recognition = null;
    const segmentRecorder = this.segmentRecorder;
    this.segmentRecorder = null;
    const segmentStopped = segmentRecorder && segmentRecorder.state !== 'inactive'
      ? new Promise<void>(resolve => {
          const finishSegment = segmentRecorder.onstop;
          segmentRecorder.onstop = event => { finishSegment?.call(segmentRecorder, event); resolve(); };
        })
      : Promise.resolve();
    if (segmentRecorder && segmentRecorder.state !== 'inactive') {
      try { segmentRecorder.stop(); } catch { /* 已停止 */ }
    }
    const recorder = this.recorder;
    this.recorder = null;
    const sessionId = this.sessionId;
    const stopped = recorder && recorder.state !== 'inactive'
      ? new Promise<Blob>(resolve => {
          recorder.onstop = () => resolve(new Blob(this.recordingChunks, { type: recorder.mimeType || 'audio/webm' }));
        })
      : Promise.resolve(new Blob());
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    const blob = await stopped;
    if (sessionId !== null && blob.size > 0) {
      try { await saveRecording(sessionId, blob); }
      catch {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'Parallel-recording.' + (blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm');
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
        this.onStatus('error', '录音未能存入历史，已尝试下载备份。请检查下载结果与磁盘空间');
      }
    }
    await segmentStopped;
    await this.segmentQueue.catch(() => undefined);
    await Promise.allSettled([...this.translations]);
    this.sessionId = null;
    if (sessionId !== null) {
      try { await endSession(sessionId); } catch { /* 状态更新失败可忽略 */ }
    }
  }
}

export async function translateText(text: string, provider: Provider, targetLanguage: string): Promise<string> {
  const prompt = 'Translate the following into ' + targetLanguage + '. Keep it natural and concise. Return only the translation.\n' + text;
  const baseUrl = trimBaseUrl(provider.baseUrl);
  if (provider.protocol === 'anthropic') {
    const auth: Record<string, string> = provider.key.startsWith('sk-cp-')
      ? { authorization: 'Bearer ' + provider.key }
      : { 'x-api-key': provider.key };
    const response = await localModelRequest(baseUrl + '/messages', { 'content-type': 'application/json', ...auth, 'anthropic-version': '2023-06-01' }, { model: provider.model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] });
    if (!response.ok) throw await modelError(response, provider.name);
    const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    return (payload.content || []).filter(block => !block.type || block.type === 'text').map(block => block.text || '').join('').trim();
  }
  if (provider.protocol === 'google') {
    const response = await localModelRequest(baseUrl + '/models/' + encodeURIComponent(provider.model) + ':generateContent?key=' + encodeURIComponent(provider.key), { 'content-type': 'application/json' }, { contents: [{ parts: [{ text: prompt }] }] });
    if (!response.ok) throw await modelError(response, provider.name);
    return (((await response.json()).candidates?.[0]?.content?.parts?.[0]?.text) || '').trim();
  }
  const azure = provider.protocol === 'azure';
  const url = azure
    ? (baseUrl.includes('/deployments/')
      ? baseUrl + (baseUrl.includes('/chat/completions') ? '' : '/chat/completions') + (baseUrl.includes('?') ? '' : '?api-version=2024-10-21')
      : baseUrl + '/deployments/' + encodeURIComponent(provider.model) + '/chat/completions?api-version=2024-10-21')
    : baseUrl + '/chat/completions';
  const response = await localModelRequest(
    url,
    { 'content-type': 'application/json', ...(provider.key ? (azure ? { 'api-key': provider.key } : { authorization: 'Bearer ' + provider.key }) : {}) },
    { model: provider.model, messages: [{ role: 'system', content: 'You are a live interpreter. Reply with the translation only.' }, { role: 'user', content: prompt }], temperature: 0.3 }
  );
  if (!response.ok) throw await modelError(response, provider.name);
  return (((await response.json()).choices?.[0]?.message?.content) || '').trim();
}
