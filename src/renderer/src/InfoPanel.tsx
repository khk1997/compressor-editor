import type { Node } from '@xyflow/react'
import {
  CODEC_LABEL,
  FORMAT_CODECS,
  supportsBoomerang,
  supportsHardware,
  supportsHevcAlpha,
  supportsTarget,
  type OutputFormat,
  type VideoCodec
} from './types'

const NODE_INFO: Record<string, { title: string; desc: string }> = {
  'input-node': {
    title: 'Input · 輸入',
    desc: '選擇來源:PNG 序列(資料夾)、單一影片檔,或 Batch(整個資料夾的影片,套同一條 pipeline 各自輸出)。也可直接把檔案/資料夾拖進畫布自動建立。序列需設定 fps;影片會自動偵測資訊並顯示預覽縮圖。Batch 需搭配 Location 節點或已選輸出資料夾。'
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
    desc: '裁切畫面區域。接上 Input 後會顯示來源影格,可直接在預覽上拖曳/縮放選框,或用比例預設(1:1、16:9…)、置中、全幅。也可手動輸入 Width/Height/X/Y(px)。寬高都需 > 0 才生效。'
  },
  'output-node': {
    title: 'Output · 輸出',
    desc: '設定輸出容器、編碼、品質/目標大小與尺寸。一個來源可同時接多個 Output 產生不同格式。'
  }
}

/** Container-level description (codec choice is shown separately below). */
const FORMAT_LABEL: Record<OutputFormat, string> = {
  webp: 'WebP(動畫)',
  mp4: 'MP4(容器)',
  mov: 'MOV(容器)',
  webm: 'WebM(VP9)',
  pngseq: 'PNG'
}

const FORMAT_INFO: Record<OutputFormat, string> = {
  webp: '動畫圖片格式,可保留透明 alpha。適合網頁短動畫、貼圖。無音訊。檔案通常比影片小但畫質有限。',
  mp4: '相容性最高的影片容器,幾乎所有裝置/瀏覽器都能播。可裝 H.264 / H.265 / AV1,用下面的 Codec 選擇。不支援透明。',
  mov: '剪輯用容器。預設 ProRes(高品質中間檔,檔案很大);也可改用 H.264 / H.265 壓成較小的檔案。用下面的 Codec 切換。',
  webm: 'VP9。網頁友善,可保留透明 alpha(瀏覽器可解),壓縮率優於 H.264。編碼較慢。Safari 舊版支援有限。',
  pngseq:
    '無損 PNG 圖檔(保留透明 alpha、無音訊)。可輸出「序列」(所有影格)或「單張」(挑其中一格)。用下面的 PNG 模式切換。適合丟進其他軟體做後續處理、修圖或重新合成。'
}

/** Per-codec guidance, shown for whichever codecs the chosen container offers. */
const CODEC_GUIDE: Record<VideoCodec, string> = {
  h264: '相容性最高、編碼快、檔案較大,用品質滑桿控畫質。不支援透明。日常首選。',
  h265: '同畫質比 H.264 小 30–50%,編碼較慢、舊裝置支援較差(已加 hvc1 標籤利於 Apple 播放)。在 MOV 容器下可勾「Keep alpha」輸出 Apple HEVC-with-Alpha 保留透明。',
  av1: '壓縮率最佳(同畫質再比 H.265 小一截),適合串流/保存。編碼最慢,需較新裝置才能播。不支援透明。',
  prores: '剪輯用高品質中間檔,用 profile 控畫質,檔案最大;選 4444 profile 可保留透明 alpha。'
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
  const codecs = fmt ? FORMAT_CODECS[fmt] : []
  const codec: VideoCodec | null = fmt
    ? ((node.data as { codec?: VideoCodec }).codec ?? codecs[0] ?? 'h264')
    : null

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

      {fmt === 'pngseq' && (
        <>
          <div className="info-sub">PNG · 輸出模式</div>
          <div className="info-desc">
            <b>序列(所有影格)</b> — 每一格輸出成一張,放進以檔名命名的子資料夾(如
            frames/frames_00001.png)。
            <br />
            <b>單張(單一影格)</b> — 只輸出一張 PNG 到你選的位置(不進子資料夾)。拖預覽下方的滑桿即時挑格
            (或用數字欄精準輸入,0 起算);來源只有一張圖就填 0。預覽顯示的是來源影格(裁切/變速不套用)。
          </div>
        </>
      )}

      {fmt && supportsBoomerang(fmt) && (
        <>
          <div className="info-sub">Loop · 循環</div>
          <div className="info-desc">
            <b>Normal</b> — 正常單向循環(播到底後從頭再播)。
            <br />
            <b>Boomerang(往返)</b> — 播到底後反向播回開頭,來回擺動。作法是把影格接上反轉的一段
            (兩端各去一張避免頓格),所以長度約變兩倍、檔案較大、輸出較久。所有格式皆可用;影片
            (MP4/MOV/WebM)會靜音輸出,長片較吃記憶體;因長度翻倍無法精準命中檔案大小,選
            Boomerang 時會自動改用 Quality 模式。
          </div>
        </>
      )}

      {codecs.length > 0 && (
        <>
          <div className="info-sub">Codec</div>
          <ul className="info-list">
            {codecs.map((c) => (
              <li key={c}>
                <b>{CODEC_LABEL[c]}</b> — {CODEC_GUIDE[c]}
              </li>
            ))}
          </ul>
        </>
      )}

      {fmt === 'mov' && codec === 'prores' && (
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

      {fmt && codec && supportsTarget(fmt, codec) && (
        <>
          <div className="info-sub">Size by</div>
          <div className="info-desc">
            <b>Quality (CRF)</b> — 固定畫質,檔案大小由內容決定。
            <br />
            <b>Target file size</b> — 你指定 MB 數,程式反推碼率壓到接近該大小(2-pass)。
          </div>
        </>
      )}

      {fmt && codec && supportsHardware(fmt, codec) && (
        <>
          <div className="info-sub">Hardware encode</div>
          <div className="info-desc">
            用 Mac VideoToolbox 硬體編碼,速度快很多、較省電;畫質/壓縮率略遜於軟體編碼。
          </div>
        </>
      )}

      {fmt && codec && supportsHevcAlpha(fmt, codec) && (
        <>
          <div className="info-sub">Keep alpha (HEVC)</div>
          <div className="info-desc">
            輸出 Apple「HEVC with Alpha」保留透明通道,給 Final Cut / Motion / 網頁去背用。只能走
            VideoToolbox 硬體編碼(勾選後自動套用);來源需本身帶 alpha(如 PNG 序列、ProRes
            4444、WebM alpha)。
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
