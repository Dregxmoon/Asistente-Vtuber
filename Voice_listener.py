"""
voice_listener.py — escucha el micrófono y detecta wake words.
Ahora acepta --mic-index para usar el dispositivo seleccionado por el usuario.

Salida por stdout (una línea JSON por evento):
  {"type": "wake"}
  {"type": "command", "text": "abre el chat"}
  {"type": "error", "msg": "..."}
"""

import sys
import json
import time
import argparse

def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)

try:
    import speech_recognition as sr
except ImportError:
    emit({"type": "error", "msg": "speech_recognition no instalado. Corre: pip install SpeechRecognition pyaudio"})
    sys.exit(1)

# ── Wake words ────────────────────────────────────────────────────────────────
WAKE_WORDS = [
    'marzo', 'march', '7 de marzo', 'siete de marzo',
    'hola marzo', 'oye marzo', 'hey marzo', 'march 7'
]

# ── Config ────────────────────────────────────────────────────────────────────
LISTEN_TIMEOUT   = 5
PHRASE_LIMIT     = 8
ENERGY_THRESHOLD = 300

recognizer = sr.Recognizer()
recognizer.energy_threshold         = ENERGY_THRESHOLD
recognizer.dynamic_energy_threshold = True
recognizer.pause_threshold          = 0.7


def transcribe(audio):
    try:
        return recognizer.recognize_google(audio, language='es-MX').lower().strip()
    except sr.UnknownValueError:
        return None
    except sr.RequestError as e:
        emit({"type": "error", "msg": f"STT error: {e}"})
        return None


def contains_wake(text):
    return any(w in text for w in WAKE_WORDS)


def extract_command(text):
    for w in sorted(WAKE_WORDS, key=len, reverse=True):
        idx = text.find(w)
        if idx != -1:
            return text[idx + len(w):].strip()
    return text


def find_best_microphone():
    """Prueba cada micrófono y devuelve el índice del primero que funcione."""
    names = sr.Microphone.list_microphone_names()

    PREFERRED = ['headset', 'auricular', 'razer', 'hyperx', 'rode', 'blue', 'usb audio', 'webcam']
    SKIP      = ['output', 'altavoc', 'speaker', 'spdif', 'hdmi', 'nvidia', 'mapper', 'spatial', 'game']

    candidates = []
    for i, name in enumerate(names):
        n = name.lower()
        if any(s in n for s in SKIP):
            continue
        score = next((10 - j for j, p in enumerate(PREFERRED) if p in n), 0)
        candidates.append((score, i, name))

    candidates.sort(reverse=True)

    test_rec = sr.Recognizer()
    for score, idx, name in candidates:
        try:
            with sr.Microphone(device_index=idx) as mic:
                test_rec.adjust_for_ambient_noise(mic, duration=0.3)
                emit({"type": "log", "msg": f"probando micrófono {idx}: {name}"})
                return idx, name
        except Exception:
            continue

    return None, "default"


def validate_mic_index(index):
    """Verifica que el índice exista y sea accesible."""
    names = sr.Microphone.list_microphone_names()
    if index < 0 or index >= len(names):
        return False, f"índice {index} fuera de rango (hay {len(names)} dispositivos)"

    test_rec = sr.Recognizer()
    try:
        with sr.Microphone(device_index=index) as mic:
            test_rec.adjust_for_ambient_noise(mic, duration=0.2)
        return True, names[index]
    except Exception as e:
        return False, str(e)


def list_all_microphones():
    """Emite la lista completa de micrófonos al log."""
    names = sr.Microphone.list_microphone_names()
    for i, name in enumerate(names):
        emit({"type": "log", "msg": f"  [{i}] {name}"})


def main():
    parser = argparse.ArgumentParser(description='March 7th voice listener')
    parser.add_argument(
        '--mic-index', type=int, default=None,
        help='Índice del dispositivo de micrófono a usar (None = auto-detectar)'
    )
    args = parser.parse_args()

    emit({"type": "ready"})

    # Listar todos los micrófonos disponibles en el log
    emit({"type": "log", "msg": "Micrófonos disponibles:"})
    list_all_microphones()

    # Determinar qué micrófono usar
    if args.mic_index is not None:
        emit({"type": "log", "msg": f"Usando micrófono indicado por el usuario: índice {args.mic_index}"})
        ok, info = validate_mic_index(args.mic_index)
        if ok:
            mic_index = args.mic_index
            mic_name  = info
            emit({"type": "log", "msg": f"Micrófono válido: {mic_name}"})
        else:
            emit({"type": "log", "msg": f"Micrófono {args.mic_index} no accesible ({info}), usando auto-detección"})
            mic_index, mic_name = find_best_microphone()
    else:
        mic_index, mic_name = find_best_microphone()

    emit({"type": "log", "msg": f"Micrófono seleccionado: [{mic_index}] {mic_name}"})

    with sr.Microphone(device_index=mic_index) as mic:
        recognizer.adjust_for_ambient_noise(mic, duration=1)
        emit({"type": "calibrated"})

        while True:
            try:
                # ── Fase 1: esperar wake word ─────────────────────────────────
                audio = recognizer.listen(mic, phrase_time_limit=PHRASE_LIMIT)
                text  = transcribe(audio)
                if not text:
                    continue

                if not contains_wake(text):
                    continue

                # Wake detectado
                emit({"type": "wake"})
                command = extract_command(text)

                if command:
                    emit({"type": "command", "text": command})
                    continue

                # ── Fase 2: escuchar comando ──────────────────────────────────
                emit({"type": "listening"})
                try:
                    audio2 = recognizer.listen(mic, timeout=LISTEN_TIMEOUT, phrase_time_limit=PHRASE_LIMIT)
                    text2  = transcribe(audio2)
                    if text2:
                        emit({"type": "command", "text": text2})
                    else:
                        emit({"type": "timeout"})
                except sr.WaitTimeoutError:
                    emit({"type": "timeout"})

            except sr.WaitTimeoutError:
                continue
            except KeyboardInterrupt:
                break
            except Exception as e:
                emit({"type": "error", "msg": str(e)})
                time.sleep(1)


if __name__ == '__main__':
    main()