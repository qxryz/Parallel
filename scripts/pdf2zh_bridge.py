#!/usr/bin/env python3
"""Small JSON bridge around PDFMathTranslate's precise and fast kernels.

The browser never talks to Python directly. Vite writes a short-lived config
file, this process emits newline-delimited progress, and the caller reads the
generated mono/dual PDFs from the temporary output directory.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from string import Template


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def create_translator(config: dict):
    from pdf2zh import translator as translators

    service_value = str(config.get("service") or "google")
    service_name, _, service_model = service_value.partition(":")
    supported = (
        "GoogleTranslator", "BingTranslator", "DeepLTranslator", "DeepLXTranslator",
        "OllamaTranslator", "XinferenceTranslator", "AzureOpenAITranslator",
        "OpenAITranslator", "ZhipuTranslator", "ModelScopeTranslator",
        "SiliconTranslator", "GeminiTranslator", "AzureTranslator",
        "TencentTranslator", "DifyTranslator", "AnythingLLMTranslator",
        "ArgosTranslator", "GrokTranslator", "GroqTranslator",
        "DeepseekTranslator", "OpenAIlikedTranslator", "QwenMtTranslator",
    )
    prompt_text = str(config.get("prompt") or "").strip()
    prompt = Template(prompt_text) if prompt_text else None
    for class_name in supported:
        translator_class = getattr(translators, class_name)
        if translator_class.name == service_name:
            return translator_class(
                config.get("langIn", "en"),
                config.get("langOut", "zh"),
                service_model,
                envs=config.get("envs") or {},
                prompt=prompt,
                ignore_cache=not bool(config.get("useCache", True)),
            )
    raise RuntimeError(f"精确内核不支持翻译服务：{service_name}")


def translate_precise(page_input: Path, page_dir: Path, model, translator, config: dict, current: int, total: int):
    from babeldoc.high_level import TRANSLATE_STAGES, do_translate
    from babeldoc.progress_monitor import ProgressMonitor
    from babeldoc.translation_config import TranslationConfig, WatermarkOutputMode
    from pdf2zh.translator import OpenAITranslator

    translation_config = TranslationConfig(
        input_file=str(page_input),
        output_dir=str(page_dir),
        doc_layout_model=model,
        translator=translator,
        lang_in=config.get("langIn", "en"),
        lang_out=config.get("langOut", "zh"),
        no_dual=False,
        no_mono=False,
        formular_font_pattern=str(config.get("vfont") or "") or None,
        qps=max(1, min(8, int(config.get("thread", 4)))),
        use_rich_pbar=False,
        disable_rich_text_translate=not isinstance(translator, OpenAITranslator),
        skip_clean=not bool(config.get("subsetFonts", True)),
        enhance_compatibility=bool(config.get("compatible", False)),
        report_interval=0.5,
        watermark_output_mode=WatermarkOutputMode.NoWatermark,
    )
    stage_labels = {
        "parse": "正在读取页面结构",
        "detect": "正在识别页面类型",
        "layout": "正在分析版面",
        "table": "正在识别表格",
        "paragraph": "正在整理段落",
        "style": "正在识别公式与样式",
        "translate": "正在翻译文字",
        "typeset": "正在排版译文",
        "font": "正在匹配字体",
        "save": "正在生成译文页",
    }
    def report(**event):
        if event.get("type") in {"progress_start", "progress_update", "progress_end"}:
            stage = str(event.get("stage") or "").lower()
            message = next((label for key, label in stage_labels.items() if key in stage), "正在处理页面")
            emit({
                "type": "page_progress",
                "current": current,
                "total": total,
                "progress": float(event.get("overall_progress") or 0),
                "message": message,
            })
    with ProgressMonitor(TRANSLATE_STAGES, progress_change_callback=report, report_interval=0.5) as monitor:
        result = do_translate(monitor, translation_config)
    return (
        str(result.mono_pdf_path) if result.mono_pdf_path else None,
        str(result.dual_pdf_path) if result.dual_pdf_path else None,
    )


def main() -> int:
    if len(sys.argv) != 2:
        emit({"type": "error", "message": "缺少任务配置"})
        return 2

    config_path = Path(sys.argv[1])
    config = json.loads(config_path.read_text(encoding="utf-8"))

    # BabelDOC 0.2.x still uses the removed binary form of numpy.fromstring.
    # Keep the compatibility local to this worker instead of mutating the
    # bundled third-party package on disk.
    import numpy as np

    original_fromstring = np.fromstring

    def compatible_fromstring(value, dtype=float, count=-1, sep="", **kwargs):
        if not sep and isinstance(value, (bytes, bytearray, memoryview)):
            return np.frombuffer(value, dtype=dtype, count=count)
        return original_fromstring(value, dtype=dtype, count=count, sep=sep, **kwargs)

    np.fromstring = compatible_fromstring

    # Tencent's split SDK removed two legacy symbols in newer wheels. The
    # stable PDFMathTranslate release imports them eagerly even when another
    # translator is selected, so provide harmless compatibility stubs.
    try:
        from tencentcloud.tmt.v20180321 import models as tmt_models

        if not hasattr(tmt_models, "TextTranslateRequest"):
            tmt_models.TextTranslateRequest = type("TextTranslateRequest", (), {})
        if not hasattr(tmt_models, "TextTranslateResponse"):
            tmt_models.TextTranslateResponse = type("TextTranslateResponse", (), {})
    except Exception:
        pass

    import pymupdf

    from pdf2zh.doclayout import OnnxModel as FastOnnxModel
    from pdf2zh.high_level import translate

    input_path = str(Path(config["input"]).resolve())
    output_path = str(Path(config["output"]).resolve())

    try:
        emit({"type": "stage", "stage": "layout", "message": "正在分析版面"})
        onnx_path = str(config.get("onnxPath") or "").strip()
        mode = config.get("mode", "precise")
        if mode == "precise":
            from babeldoc.docvision.doclayout import OnnxModel as PreciseOnnxModel
            from babeldoc.high_level import init as babeldoc_init

            babeldoc_init()
            model = PreciseOnnxModel(onnx_path) if onnx_path else PreciseOnnxModel.load_available()
            translator = create_translator(config)
        else:
            model = FastOnnxModel(onnx_path) if onnx_path else FastOnnxModel.load_available()
            translator = None
        source = pymupdf.open(input_path)
        total = source.page_count
        if total < 1:
            raise RuntimeError("PDF 没有可翻译的页面")

        page_root = Path(output_path) / "pages"
        page_root.mkdir(parents=True, exist_ok=True)
        start_page = max(1, min(total + 1, int(config.get("startPage", 1))))
        end_page = min(total, int(config.get("endPage", 0)) or total)

        # Both kernels return only after a document completes. Calling them one
        # page at a time lets the UI display each page immediately while reusing
        # the loaded layout model and translator for the whole job.
        for page_index in range(start_page - 1, end_page):
            current = page_index + 1
            emit({"type": "page_start", "current": current, "total": total})
            page_dir = page_root / f"{current:04d}"
            page_dir.mkdir(parents=True, exist_ok=True)
            page_input = page_dir / f"page-{current:04d}.pdf"
            page_input.unlink(missing_ok=True)
            for stale in (*page_dir.glob("*mono.pdf"), *page_dir.glob("*dual.pdf")):
                stale.unlink(missing_ok=True)
            single = pymupdf.open()
            single.insert_pdf(source, from_page=page_index, to_page=page_index)
            single.save(page_input)
            single.close()

            if mode == "precise":
                mono, dual = translate_precise(page_input, page_dir, model, translator, config, current, total)
            else:
                prompt_text = str(config.get("prompt") or "").strip()
                results = translate(
                    files=[str(page_input)], output=str(page_dir),
                    lang_in=config.get("langIn", "en"), lang_out=config.get("langOut", "zh"),
                    service=config.get("service", "google"),
                    thread=max(1, min(8, int(config.get("thread", 4)))),
                    vfont=str(config.get("vfont") or ""), envs=config.get("envs") or {},
                    prompt=Template(prompt_text) if prompt_text else None, model=model,
                    compatible=bool(config.get("compatible", False)),
                    skip_subset_fonts=not bool(config.get("subsetFonts", True)),
                    ignore_cache=not bool(config.get("useCache", True)),
                )
                if not results:
                    raise RuntimeError(f"第 {current} 页没有生成译文")
                mono, dual = results[0]
            if not mono or not Path(mono).exists():
                raise RuntimeError(f"第 {current} 页没有生成单语译文")
            emit({"type": "page_complete", "current": current, "total": total, "mono": mono, "dual": dual})

        source.close()
        emit({"type": "complete", "total": total})
        return 0
    except Exception as error:
        emit({"type": "error", "message": str(error) or "PDF 翻译失败"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
