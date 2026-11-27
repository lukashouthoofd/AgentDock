"""Render the AgentDock launch animation using vendored artwork and no network."""

import argparse
import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parents[1]
SIZE = (640, 360)
FPS = 24
FRAMES = 67
TUX_CREDIT = "Tux illustration by Larry Ewing (lewing@isc.tamu.edu) and The GIMP."
GOLD = (248, 194, 108)
INK = (17, 20, 27)


def phase(time, start, end):
    return max(0.0, min(1.0, (time - start) / (end - start)))


def ease(value):
    return value * value * (3 - 2 * value)


def between(start, end, value):
    return start + (end - start) * value


def backdrop():
    result = Image.new("RGBA", SIZE)
    width, height = SIZE
    for y in range(height):
        for x in range(width):
            radius = math.hypot((x - 322) / 350, (y - 181) / 210)
            light = round(11 * max(0, 1 - radius) ** 1.6)
            result.putpixel((x, y), (*[channel + light for channel in INK], 255))
    draw = ImageDraw.Draw(result)
    draw.line((136, 248, 504, 248), fill=(34, 41, 55), width=1)
    return result


def sprite(frame, image, x, y, height, angle=0, squash=0):
    width = round(height * image.width / image.height * (1 + squash * 0.7))
    scaled = image.resize((width, round(height * (1 - squash))), Image.Resampling.LANCZOS)
    if angle:
        scaled = scaled.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    frame.alpha_composite(scaled, (round(x - scaled.width / 2), round(y - scaled.height / 2)))


def render(time, background, tux, icon, title_font):
    frame = background.copy()
    draw = ImageDraw.Draw(frame)
    step = phase(time, 0, 0.61)
    hop = math.sin(3 * math.pi * step) ** 2
    landing = phase(time, 1.54, 1.83)
    squash = 0.19 * math.sin(math.pi * landing)
    settle = ease(phase(time, 1.75, 2.13))
    lift = phase(time, 0.84, 1.56)
    flight = math.sin(math.pi * lift)
    return_tile = ease(phase(time, 1.56, 2.13))

    penguin_x = between(131, 222, ease(step)) + 21 * settle
    penguin_y = 191 - 7 * hop + 51 * squash
    logo_x = between(346, 230, lift) + 131 * return_tile
    logo_y = 185 - 57 * flight - 81 * lift + 81 * return_tile
    logo_angle = -360 * lift - 8 * math.sin(math.pi * return_tile)

    draw.ellipse((penguin_x - 44, 242, penguin_x + 44, 252), fill=(12, 15, 21))
    draw.ellipse((logo_x - 42 + 14 * flight, 242, logo_x + 42 - 14 * flight, 252), fill=(12, 15, 21))
    if 0.64 < time < 0.94:
        # The extended flipper reaches the edge of the tile before it launches.
        reach = math.sin(math.pi * phase(time, 0.64, 0.99))
        draw.line((penguin_x + 30, 194, 252 + 47 * reach, 193 - 10 * reach), fill=(15, 17, 20), width=13)
        tip_x, tip_y = 252 + 47 * reach, 193 - 10 * reach
        draw.ellipse((tip_x - 6, tip_y - 6, tip_x + 6, tip_y + 6), fill=(15, 17, 20))
    if 0.83 < time < 1.10:
        # Three rays make the brief contact readable even at a small window size.
        burst = phase(time, 0.83, 1.10)
        amber = tuple(round(between(GOLD[i], INK[i], burst)) for i in range(3))
        for angle in (-0.8, 0.24, 1.27):
            start = 10 + 14 * burst
            end = start + 10 * (1 - burst)
            draw.line(
                (299 + math.cos(angle) * start, 182 + math.sin(angle) * start,
                 299 + math.cos(angle) * end, 182 + math.sin(angle) * end),
                fill=amber,
                width=2,
            )
    sprite(frame, tux, penguin_x, penguin_y, 112, 5 * math.sin(3 * math.pi * step) - 11 * squash, squash)
    if 1.11 < time < 1.56:
        draw.rounded_rectangle((176, 131, 180, 145), radius=2, fill=GOLD)
        draw.ellipse((176, 149, 180, 153), fill=GOLD)
    sprite(frame, icon, logo_x, logo_y, 125, logo_angle)

    wordmark = ease(phase(time, 1.91, 2.21))
    if wordmark:
        ink = (225, 231, 241)
        shade = tuple(round(between(INK[i], ink[i], wordmark)) for i in range(3))
        draw.text((320, 292 + 9 * (1 - wordmark)), "AgentDock", font=title_font, fill=shade, anchor="mm")
    return frame.convert("RGB")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--icon", type=Path, default=ROOT / "src-tauri/icons/icon.png")
    parser.add_argument("--output", type=Path, default=ROOT / "public/agentdock-intro.webm")
    parser.add_argument("--ffmpeg", help="Path to an FFmpeg executable with libvpx")
    args = parser.parse_args()

    if args.ffmpeg:
        ffmpeg = args.ffmpeg
    else:
        from imageio_ffmpeg import get_ffmpeg_exe

        ffmpeg = get_ffmpeg_exe()

    with Image.open(SOURCE / "Tux.png") as tux_image, Image.open(args.icon) as icon_image:
        tux = tux_image.convert("RGBA")
        tux = tux.crop(tux.getbbox())
        icon = icon_image.convert("RGBA")
    background = backdrop()
    title_font = ImageFont.load_default(size=33)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{SIZE[0]}x{SIZE[1]}",
        "-framerate", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libvpx", "-pix_fmt", "yuv420p",
        "-threads", "1", "-deadline", "good", "-cpu-used", "2", "-crf", "17", "-b:v", "0",
        "-g", str(FRAMES), "-fflags", "+bitexact", "-metadata", f"comment={TUX_CREDIT}",
        str(args.output.resolve()),
    ]
    with subprocess.Popen(command, stdin=subprocess.PIPE) as encoder:
        for index in range(FRAMES):
            encoder.stdin.write(render(index / FPS, background, tux, icon, title_font).tobytes())
        encoder.stdin.close()
        status = encoder.wait()
    if status:
        raise SystemExit(f"FFmpeg exited with status {status}")


if __name__ == "__main__":
    main()
