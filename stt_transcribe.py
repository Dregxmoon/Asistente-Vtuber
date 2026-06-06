#!/usr/bin/env python3
import sys, json, os, time, threading, argparse, zipfile, urllib.request

def emit(obj):
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(line.encode("utf-8"))
    sys.stdout.buffer.flush()

# ── Args ──────────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--mic-index", type=int, default=None)
parser.add_argument("--lang", type=str, default="es")
args = parser.parse_args()

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STOP_FILE  = os.path.join(SCRIPT_DIR, "stt_transcribe.stop")
MODEL_DIR  = os.path.join(SCRIPT_DIR, "models", "vosk-es")
MODEL_URL  = "https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip"
MODEL_ZIP  = os.path.join(SCRIPT_DIR, "models", "vosk-model-small-es-0.42.zip")

# Limpiar stop file residual
if os.path.exists(STOP_FILE):
    os.remove(STOP_FILE)

# ── Dependencias ──────────────────────────────────────────────────────────────
try:
    import numpy as np
except ImportError:
    emit({"type": "error", "msg": "numpy no instalado: pip install numpy"})
    sys.exit(1)

try:
    import sounddevice as sd
except ImportError:
    emit({"type": "error", "msg": "sounddevice no instalado: pip install sounddevice"})
    sys.exit(1)

try:
    from vosk import Model, KaldiRecognizer, SetLogLevel
    SetLogLevel(-1)
except ImportError:
    emit({"type": "error", "msg": "vosk no instalado: pip install vosk"})
    sys.exit(1)

# ── Descargar modelo si no existe ─────────────────────────────────────────────
if not os.path.exists(MODEL_DIR):
    os.makedirs(os.path.join(SCRIPT_DIR, "models"), exist_ok=True)
    emit({"type": "partial", "text": "Descargando modelo de voz (~50MB, solo la primera vez)..."})
    try:
        urllib.request.urlretrieve(MODEL_URL, MODEL_ZIP)
        with zipfile.ZipFile(MODEL_ZIP, "r") as z:
            z.extractall(os.path.join(SCRIPT_DIR, "models"))
        extracted = os.path.join(SCRIPT_DIR, "models", "vosk-model-small-es-0.42")
        if os.path.exists(extracted):
            os.rename(extracted, MODEL_DIR)
        os.remove(MODEL_ZIP)
    except Exception as e:
        emit({"type": "error", "msg": "Error descargando modelo: " + str(e)})
        sys.exit(1)

# ── Cargar modelo ─────────────────────────────────────────────────────────────
try:
    model = Model(MODEL_DIR)
except Exception as e:
    emit({"type": "error", "msg": "Error cargando modelo Vosk: " + str(e)})
    sys.exit(1)

SAMPLE_RATE  = 16000
CHUNK_FRAMES = 4000

rec = KaldiRecognizer(model, SAMPLE_RATE)
rec.SetWords(False)

emit({"type": "ready"})

# ── Grabacion + transcripcion en tiempo real ───────────────────────────────────
stop_event  = threading.Event()
audio_queue = __import__("queue").Queue()
full_text   = []

def audio_callback(indata, frames, time_info, status):
    if not stop_event.is_set():
        audio_queue.put(bytes(indata))

def watch_stop_file():
    while not stop_event.is_set():
        if os.path.exists(STOP_FILE):
            stop_event.set()
            try:
                os.remove(STOP_FILE)
            except Exception:
                pass
            break
        time.sleep(0.08)

device_kwargs = {}
if args.mic_index is not None and args.mic_index >= 0:
    device_kwargs["device"] = args.mic_index

try:
    with sd.RawInputStream(
        samplerate = SAMPLE_RATE,
        blocksize  = CHUNK_FRAMES,
        channels   = 1,
        dtype      = "int16",
        callback   = audio_callback,
        **device_kwargs
    ):
        emit({"type": "recording"})
        watcher = threading.Thread(target=watch_stop_file, daemon=True)
        watcher.start()

        while not stop_event.is_set():
            try:
                data = audio_queue.get(timeout=0.1)
            except Exception:
                continue

            if rec.AcceptWaveform(data):
                result = json.loads(rec.Result())
                text   = result.get("text", "").strip()
                if text:
                    full_text.append(text)
                    emit({"type": "sentence", "text": " ".join(full_text)})
            else:
                partial = json.loads(rec.PartialResult())
                p_text  = partial.get("partial", "").strip()
                if p_text:
                    combined = " ".join(full_text + [p_text])
                    emit({"type": "partial", "text": combined})

        result = json.loads(rec.FinalResult())
        last   = result.get("text", "").strip()
        if last:
            full_text.append(last)

except Exception as e:
    emit({"type": "error", "msg": "Error de microfono: " + str(e)})
    sys.exit(1)

final = " ".join(full_text).strip()
emit({"type": "result", "text": final})