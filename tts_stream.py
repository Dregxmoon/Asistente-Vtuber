"""
tts_stream.py — genera audio con edge-tts y lo escribe a stdout
Electron lo lee como buffer y reproduce con Web Audio API sin archivo temporal
"""
import asyncio, sys, argparse
import edge_tts

async def main():
    p = argparse.ArgumentParser()
    p.add_argument('--voice', default='ja-JP-NanamiNeural')
    p.add_argument('--rate',  default='+10%')
    p.add_argument('--pitch', default='+20Hz')
    p.add_argument('--text',  required=True)
    args = p.parse_args()

    communicate = edge_tts.Communicate(
        args.text,
        args.voice,
        rate=args.rate,
        pitch=args.pitch,
    )

    # Escribir chunks de audio directo a stdout en binario
    if hasattr(sys.stdout, 'buffer'):
        out = sys.stdout.buffer
    else:
        out = sys.stdout

    async for chunk in communicate.stream():
        if chunk['type'] == 'audio':
            out.write(chunk['data'])
            out.flush()

asyncio.run(main())