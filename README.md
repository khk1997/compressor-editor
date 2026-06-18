# Compressor

A node-based media compressor (Electron + React + React Flow). Convert PNG
sequences and video into WebP / MP4 (H.264·H.265) / MOV (ProRes) / WebM (VP9) /
AV1, with a Blender-style node graph for chaining Trim, Crop and Retime stages.

## Features

- **Inputs**: PNG sequence (auto fps/frame-count/size detection) or video (fps,
  resolution, duration, audio probed automatically).
- **Outputs**: WebP (animated, alpha via `img2webp`), MP4 (H.264 / H.265,
  hardware VideoToolbox option), MOV (ProRes Proxy→4444 with alpha), WebM (VP9
  with alpha), AV1.
- **Quality or target file size** (2-pass) per output.
- **Processing nodes**: Trim (in/out), Crop, Retime (speed / reverse / frame
  interpolation), composable in any chain.
- Blender-style graph: Ctrl/⌘-drag to cut links, drop a node onto a link to
  splice it in, per-node delete, save/load graph as JSON.
- Batch queue with progress, cancel, and reveal-in-Finder.

## Develop

```bash
npm install
npm run dev
```

FFmpeg is bundled via `ffmpeg-static`. Animated-WebP frame disposal uses
`img2webp` (libwebp) from PATH; bundling it is required for distribution.
