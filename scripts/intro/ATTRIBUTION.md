# AgentDock launch animation

The launch animation uses Tux, the original Linux penguin illustration by Larry Ewing (lewing@isc.tamu.edu), created with The GIMP. Ewing grants use and modification with acknowledgment of him and The GIMP if requested. The unmodified source PNG comes from Wikimedia Commons. The animation crops, scales, rotates and composites the image. [Author’s permission](https://web.archive.org/web/20240630095423/https://isc.tamu.edu/~lewing/linux/) · [Source PNG](https://commons.wikimedia.org/wiki/File:Tux.png)

The checked-in WebM is bundled with AgentDock. It has no runtime media dependencies. To regenerate it from the repository root, install Pillow 12.3.0 and imageio-ffmpeg 0.6.0 into an isolated Python environment, then run `python scripts/intro/generate.py`. The script also accepts `--ffmpeg` to use a local FFmpeg build with libvpx. Rendering requires no network access.
