# Compressor

A node-based media compressor (Electron + React + React Flow). Convert PNG
sequences and video into WebP / MP4 (H.264·H.265) / MOV (ProRes) / WebM (VP9) /
AV1 / PNG sequence, with a Blender-style node graph for chaining Trim, Crop and
Retime stages.

![Node-based editor — wire inputs, effects and outputs into a pipeline](docs/banners/01-node-based.svg)

![Compress videos — shrink MP4, MOV, WebM and WebP](docs/banners/02-compress.svg)

![Convert formats — one source out to many formats](docs/banners/03-convert.svg)

![Inputs show the details — resolution, fps, duration, size and audio](docs/banners/04-input-specs.svg)

![Trim, crop, retime — composable processing nodes](docs/banners/05-processing.svg)

## Features

- **Inputs**: PNG sequence (auto fps/frame-count/size detection) or video (fps,
  resolution, duration, audio probed automatically).
- **Outputs**: WebP (animated, alpha via `img2webp`), MP4 (H.264 / H.265,
  hardware VideoToolbox option), MOV (ProRes Proxy→4444 with alpha), WebM (VP9
  with alpha), AV1, PNG sequence (lossless, alpha-preserving frames to a folder).
- **Quality or target file size** (2-pass) per output.
- **Processing nodes**: Trim (in/out), Crop, Retime (speed / reverse / frame
  interpolation), composable in any chain.
- Blender-style graph: a knife/scissors tool to cut links (toolbar toggle, or
  Ctrl/⌘-drag), drop a node onto a link to splice it in, per-node delete,
  save/load graph as JSON.
- Batch queue with progress, cancel, and reveal-in-Finder.

## Develop

```bash
npm install
npm run dev
```

FFmpeg is bundled via `ffmpeg-static`. Animated-WebP frame disposal uses
`img2webp` (libwebp) from PATH; bundling it is required for distribution.
