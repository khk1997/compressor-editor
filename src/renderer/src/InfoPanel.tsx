import type { Node } from '@xyflow/react'
import type { OutputFormat } from './types'

const NODE_INFO: Record<string, { title: string; desc: string }> = {
  'input-node': {
    title: 'Input · 輸入',
    desc: '選擇來源:PNG 序列(資料夾)或影片檔。序列需設定 fps;影片會自動偵測 fps、解析度、時長與音軌。'
  },
  'retime-node': {
    title: 'Retime · 變速',
    desc: '改變播放速度(50% = 慢動作、變長;200% = 加速、變短)、反向播放,以及補幀方式。'
  },
  'trim-node': {
    title: 'Trim · 修剪',
    desc: '用進/出點(秒)裁切片段,影像與音訊同步裁切,並自動修正輸出時長。'
  },
  'crop-node': {
    title: 'Crop · 裁切',
    desc: '裁切畫面區域。Width/Height 是裁切後尺寸,X/Y 是左上角起點(單位 px)。寬高都需 > 0 才生效。'
  },
  'output-node': {
    title: 'Output · 輸出',
    desc: '設定輸出格式、品質/目標大小與尺寸。一個來源可同時接多個 Output 產生不同格式。'
  }
}

const FORMAT_LABEL: Record<OutputFormat, string> = {
  webp: 'WebP(動畫)',
  mp4: 'MP4(H.264)',
  h265: 'MP4(H.265 / HEVC)',
  mov: 'MOV(ProRes)',
  webm: 'WebM(VP9)',
  av1: 'MP4(AV1)'
}

const FORMAT_INFO: Record<OutputFormat, string> = {
  webp: '動畫圖片格式,可保留透明 alpha。適合網頁短動畫、貼圖。無音訊。檔案通常比影片小但畫質有限。',
  mp4: 'H.264。相容性最高,幾乎所有裝置/瀏覽器都能播。編碼快。不支援透明。檔案比 H.265/AV1 大。日常首選。',
  h265:
    'H.265 / HEVC。同畫質下檔案約比 H.264 小 30–50%,但編碼較慢、較舊的裝置或部分瀏覽器支援度較差(已加 hvc1 標籤以利 Apple 裝置播放)。在意檔案大小、播放環境較新時用。',
  mov: 'ProRes,剪輯用的高品質中間檔,檔案很大。Proxy→HQ 品質遞增;選 4444 profile 可保留透明 alpha。給後製/剪輯軟體用,不適合直接分享。',
  webm: 'VP9。網頁友善,可保留透明 alpha(瀏覽器可解),壓縮率優於 H.264。編碼較慢。Safari 舊版支援有限。',
  av1:
    'AV1。壓縮率最佳(同畫質比 H.265 再小一截),適合串流/長期保存。但編碼最慢,且需較新的裝置/瀏覽器才能播。'
}

const PRORES_GUIDE: { name: string; text: string }[] = [
  { name: 'Proxy', text: '最低碼率,離線剪輯/預覽用,檔案最小、畫質最低。' },
  { name: 'LT', text: '輕量,品質高於 Proxy,仍偏小。' },
  { name: 'Standard (422)', text: '一般用途,品質與檔案大小平衡。' },
  { name: 'HQ (422 HQ)', text: '高品質,母帶/交付常用,檔案大。' },
  { name: '4444', text: '最高品質,且含 alpha 透明通道,檔案最大。要透明選這個。' }
]

const INTERP_GUIDE: { name: string; text: string }[] = [
  { name: 'Frame sampling', text: '直接重複/丟棄影格,最快;慢動作會有頓格感。' },
  { name: 'Frame blending', text: '混合相鄰影格,較順,但有殘影。' },
  { name: 'Optical flow', text: '運動估算生成全新影格,最順、慢動作最佳,但最慢。' }
]

export function InfoPanel({ node }: { node: Node | undefined }): JSX.Element | null {
  if (!node || !node.type) return null
  const info = NODE_INFO[node.type]
  if (!info) return null
  const fmt = node.type === 'output-node' ? (node.data as { format: OutputFormat }).format : null
  const targetable = fmt === 'mp4' || fmt === 'h265'

  return (
    <aside className="infopanel">
      <div className="info-title">{info.title}</div>
      <div className="info-desc">{info.desc}</div>

      {fmt && (
        <>
          <div className="info-sub">格式:{FORMAT_LABEL[fmt]}</div>
          <div className="info-desc">{FORMAT_INFO[fmt]}</div>
        </>
      )}

      {fmt === 'mov' && (
        <>
          <div className="info-sub">ProRes profile</div>
          <ul className="info-list">
            {PRORES_GUIDE.map((p) => (
              <li key={p.name}>
                <b>{p.name}</b> — {p.text}
              </li>
            ))}
          </ul>
        </>
      )}

      {targetable && (
        <>
          <div className="info-sub">Size by</div>
          <div className="info-desc">
            <b>Quality (CRF)</b> — 固定畫質,檔案大小由內容決定。
            <br />
            <b>Target file size</b> — 你指定 MB 數,程式反推碼率壓到接近該大小(2-pass)。
          </div>
          <div className="info-sub">Hardware encode</div>
          <div className="info-desc">
            用 Mac VideoToolbox 硬體編碼,速度快很多、較省電;畫質/壓縮率略遜於軟體編碼。
          </div>
        </>
      )}

      {node.type === 'retime-node' && (
        <>
          <div className="info-sub">Time interpolation</div>
          <ul className="info-list">
            {INTERP_GUIDE.map((p) => (
              <li key={p.name}>
                <b>{p.name}</b> — {p.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}
