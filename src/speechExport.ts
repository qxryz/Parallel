import JSZip from 'jszip';
import type { InterpretationTurn, SessionSummary } from './localDb';

export function recordingExtension(type: string): string {
  if (type.includes('mp4')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg')) return 'mp3';
  return 'webm';
}

export function transcriptMarkdown(session: SessionSummary, turns: InterpretationTurn[]): string {
  return `# 同声传译记录\n\n${session.sourceLanguage} → ${session.targetLanguage}\n\n${session.startedAt}\n\n`
    + [...turns].sort((a, b) => a.durationMs - b.durationMs || a.id - b.id).map(turn => {
      const seconds = Math.max(0, Math.floor(turn.durationMs / 1000));
      const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      return `### ${time} ${turn.role === 'source' ? '原文' : '译文'}\n\n${turn.text}\n`;
    }).join('\n');
}

export async function exportSpeechSession(session: SessionSummary, turns: InterpretationTurn[], recording: Blob | null): Promise<File> {
  if (!turns.length && !recording?.size) throw new Error('这条历史没有已保存的文字或录音。正在录音时，请先停止并等待保存完成。');
  const zip = new JSZip();
  if (turns.length) zip.file('同传文字.md', '\ufeff' + transcriptMarkdown(session, turns));
  if (recording?.size) zip.file('录音.' + recordingExtension(recording.type), await recording.arrayBuffer());
  return new File([await zip.generateAsync({ type: 'blob' })], `同传-${session.id}-${session.startedAt.slice(0, 10)}.zip`, { type: 'application/zip' });
}
