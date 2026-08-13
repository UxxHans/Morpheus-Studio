// Port of Downloads/BeatEditorWindow.cs (Unity Editor beatmap tool) onto an HTML canvas.
// Coordinate math, hit-testing, interaction rules and the CSV format are kept 1:1 with the
// original so files this produces are read back by MusicCollectionSelection.cs unchanged.
import { bridge, toast, confirmDialog } from "./bridge.js";
import { SKY_PRESETS, findSkyPresetIndex } from "./skyPresets.js";
import { difficultyLabel } from "./difficulty.js";
import { ICONS } from "./icons.js";

// ── Constants (mirrors BeatEditorWindow.cs) ──────────────────────────────
// Base (unscaled) reference heights — the sky lane + note tracks scale together to
// fill whatever vertical space is available; the waveform strip and scrollbar stay fixed.
const BASE_TRACK_HEIGHT = 26;
const HEADER_WIDTH = 72;
const BASE_SKY_LANE_H = BASE_TRACK_HEIGHT; // sky lane is the same height as a normal track lane
const WAVEFORM_H = 120;
const SCROLLBAR_H = 26;
const MIN_HOLD_DUR = 0.08;
const MIN_SKY_DUR = 3;
const DEFAULT_SKY_DUR = 10;
const RESIZE_ZONE_PX = 8;
const HANDLE_W = 24;

const TRACKS = ["A", "B", "C", "D", "E", "F", "G", "H", "HVY", "REC"];
const REC_TRACK = "REC";
const REC_CATEGORY = "Record";
const HEAVY_TRACK = "HVY";
const HEAVY_CATEGORY = "Heavy";

// Nested pairing for the lettered lanes: D/E are the innermost pair (always on once
// TrackCount >= 2), then C/F, then B/G, then A/H only join at the full 8-track layout.
// Lanes whose tier exceeds the song's configured TrackCount are grayed out and inert.
const TRACK_TIERS = { D: 2, E: 2, C: 4, F: 4, B: 6, G: 6, A: 8, H: 8 };

const EMPTY_CSV_HEADER = "NoteTrackName,NoteTime,IsRelease,NoteCategory\n";

function baseTrackH(track) {
  return BASE_TRACK_HEIGHT; // HVY/REC used to be a compact half-height lane; now uniform with the rest
}
function baseNoteMargin(track) {
  return 5;
}
const BASE_TRACKS_TOTAL_H = TRACKS.reduce((sum, t) => sum + baseTrackH(t), 0);
function trackLabel(track) {
  if (track === REC_TRACK) return "录制区";
  if (track === HEAVY_TRACK) return "重音区";
  const tier = TRACK_TIERS[track];
  return tier ? `轨道×${tier}` : track;
}
function isHold(note) {
  return note.endTime - note.startTime > MIN_HOLD_DUR;
}
function categoryColor(cat) {
  switch (cat) {
    case "Drums": return "rgb(255,122,26)";
    case "Other": return "rgb(56,220,210)";
    case "Record": return "rgb(255,217,51)";
    case "Heavy": return "rgb(255,71,71)";
    default: return "rgb(217,217,217)";
  }
}

// ── CSV parse / serialize (mirrors LoadCSV / SaveCSV) ───────────────────
function parseCsv(text) {
  const notes = [];
  const timingPoints = [];
  const skyPoints = [];
  const stacks = new Map();
  const skyStack = [];
  const lines = (text || "").split(/\r?\n/);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const p = line.split(",");
    if (p.length < 4) continue;
    const track = p[0].trim();

    if (track === "#BPM") {
      const tpTime = parseFloat(p[1]);
      if (Number.isNaN(tpTime)) continue;
      const parts = p[3].trim().split("|");
      const tpBpm = parseFloat(parts[0]);
      if (parts.length < 1 || Number.isNaN(tpBpm)) continue;
      let tpOffset = 0;
      if (parts.length >= 2) {
        const o = parseFloat(parts[1]);
        if (!Number.isNaN(o)) tpOffset = o;
      }
      timingPoints.push({ startTime: tpTime, bpm: tpBpm, offset: tpOffset });
      continue;
    }

    if (track === "#SKY") {
      const skyTime = parseFloat(p[1]);
      if (Number.isNaN(skyTime)) continue;
      const isRelease = p[2].trim().toLowerCase() === "true";
      if (!isRelease) {
        const sp = p[3].trim().split("|");
        if (sp.length >= 4) {
          const tod = parseFloat(sp[0]), scale = parseFloat(sp[1]), dens = parseFloat(sp[2]), h = parseFloat(sp[3]);
          if (![tod, scale, dens, h].some(Number.isNaN)) {
            skyStack.push({ startTime: skyTime, timeOfDay: tod, cloudScale: scale, cloudDensity: dens, cloudHeight: h });
          }
        }
      } else if (skyStack.length > 0) {
        const open = skyStack.pop();
        open.endTime = skyTime;
        skyPoints.push(open);
      }
      continue;
    }

    const time = parseFloat(p[1]);
    const isRelease = p[2].trim().toLowerCase() === "true";
    const category = p[3].trim();
    if (!isRelease) {
      if (!stacks.has(track)) stacks.set(track, []);
      stacks.get(track).push({ time, category });
    } else {
      const stk = stacks.get(track);
      if (stk && stk.length > 0) {
        const press = stk.pop();
        notes.push({ track, startTime: press.time, endTime: time, category: press.category });
      }
    }
  }

  for (const [track, stk] of stacks) {
    for (const press of stk) notes.push({ track, startTime: press.time, endTime: press.time, category: press.category });
  }

  notes.sort((a, b) => a.startTime - b.startTime);
  timingPoints.sort((a, b) => a.startTime - b.startTime);
  skyPoints.sort((a, b) => a.startTime - b.startTime);
  return { notes, timingPoints, skyPoints };
}

function serializeCsv(notes, timingPoints, skyPoints) {
  const rows = [];
  for (const note of notes) {
    rows.push([note.startTime, note.track, false, note.category]);
    if (isHold(note)) {
      const relCat = note.category === "Drums" ? "Other" : note.category;
      rows.push([note.endTime, note.track, true, relCat]);
    }
  }
  rows.sort((a, b) => a[0] - b[0]);

  let out = "NoteTrackName,NoteTime,IsRelease,NoteCategory\n";
  for (const tp of [...timingPoints].sort((a, b) => a.startTime - b.startTime))
    out += `#BPM,${tp.startTime.toFixed(4)},false,${tp.bpm.toFixed(4)}|${tp.offset.toFixed(4)}\n`;
  for (const sp of [...skyPoints].sort((a, b) => a.startTime - b.startTime)) {
    const params = `${sp.timeOfDay.toFixed(3)}|${sp.cloudScale.toFixed(3)}|${sp.cloudDensity.toFixed(3)}|${sp.cloudHeight.toFixed(3)}`;
    out += `#SKY,${sp.startTime.toFixed(4)},false,${params}\n`;
    out += `#SKY,${sp.endTime.toFixed(4)},true,${params}\n`;
  }
  for (const r of rows)
    out += `${r[1]},${r[0].toFixed(4)},${r[2] ? "True" : "False"},${r[3]}\n`;
  return out;
}

// Small bespoke chooser for the mcz-import options (confirmDialog only supports a
// single ok/cancel pair, this needs two distinct primary actions). Resolves 0 (direct
// mapping), 1 (rightmost-lane-is-heavy with 2/4/6/8 fallback), or null (cancelled).
function openMczModeModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog modal-confirm";

    const heading = document.createElement("h2");
    heading.textContent = "选择导入方式";

    const body = document.createElement("div");
    body.className = "mcz-mode-choices";

    const opt1 = document.createElement("button");
    opt1.className = "btn mcz-mode-btn";
    opt1.innerHTML = `<strong>直接映射</strong><span>mcz 有几条轨道就用几条，全部作为普通音符</span>`;

    const opt2 = document.createElement("button");
    opt2.className = "btn mcz-mode-btn";
    opt2.innerHTML = `<strong>重音轨模式</strong><span>最右侧一条轨道作为重音，其余按 2/4/6/8 轨规则回退映射</span>`;

    body.append(opt1, opt2);

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.innerHTML = ICONS.x(14);
    cancelBtn.append(document.createTextNode("取消"));
    actions.append(cancelBtn);

    dialog.append(heading, body, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    function close(result) {
      overlay.remove();
      resolve(result);
    }
    opt1.addEventListener("click", () => close(0));
    opt2.addEventListener("click", () => close(1));
    cancelBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); close(null); }
    });
  });
}

// ── ChartEditor ───────────────────────────────────────────────────────────
export class ChartEditor {
  constructor(root, difficulty) {
    this.root = root;
    this.difficulty = difficulty; // "Normal" | "Hard"
    this.song = null;
    this.rate = 0;
    this.exists = false;
    this.active = false;

    // "horizontal" (default, time flows left→right, header on the left) or "vertical"
    // (falling-note style: time flows bottom→top, header at the bottom, waveform on
    // the right). All drawing/hit-testing code below stays written in the original
    // horizontal-native logical space — _resize()/_canvasPoint() are the only two
    // places that know about orientation, swapping the logical width/height and
    // inverse-transforming pointer input respectively. See _fillTextUpright for why
    // text needs special handling on top of that.
    this.orientation = "vertical";

    this.notes = [];
    this.timingPoints = [];
    this.skyPoints = [];
    this.selectedNotes = new Set();
    this.selectedTp = null;
    this.selectedSky = null;

    this.pps = 60; // wider default view — more of the song visible before zooming in
    this.scrollX = 0;
    this.snapEnabled = true;
    this.showBeatGrid = true;
    this.tripletGrid = false;
    this.metronome = false;
    this.noteCue = true;
    this.playbackRate = 1;
    this.playhead = 0;
    this.playing = false;

    this.audioBuffer = null;
    this.audioDuration = 60;
    this.wavCache = null; // {min,max,w,pps,scrollX}

    // Web Audio playback state (see _waPlay/_waStop/_waCurrentOffset) — plays the same
    // decoded AudioBuffer used for the waveform directly, instead of a separate <audio>
    // element. <audio> has real start/seek latency and only coarse-grained currentTime;
    // AudioBufferSourceNode scheduling against the audio clock is sample-accurate.
    this._sourceNode = null;
    this._playStartCtxTime = 0;
    this._playStartOffset = 0;

    this.trackCount = 8; // how many lettered lanes are active, from the song's config
    this._laneScale = 1;
    this._skyLaneH = BASE_SKY_LANE_H;
    this._trackHeights = TRACKS.map(baseTrackH);
    this._tracksTotalH = BASE_TRACKS_TOTAL_H;

    this.clipboard = [];
    this.copyRefTime = 0;
    this.undoSnapshot = null;

    this._dragNote = null;
    this._dragResizing = false;
    this._dragOffset = 0;
    this._boxSelecting = false;
    this._boxStart = null;
    this._boxCurrent = null;
    this._dragTp = null;
    this._dragTpOffset = 0;
    this._dragSky = null;
    this._dragSkyMode = 0;
    this._dragSkyOffset = 0;
    this._sbDrag = 0;
    this._blippedNotes = new Set();
    this._prevPlayhead = 0;
    this._rafId = null;

    this._buildDom();
    this._wireEvents();
  }

  // ── DOM scaffold ─────────────────────────────────────────────────────
  _buildDom() {
    this.root.innerHTML = `
      <div class="chart-editor">
        <div class="chart-toolbar">
          <button data-a="play" class="btn">${ICONS.play(12)}播放</button>
          <button data-a="stop" class="btn" title="回到开头">${ICONS.rewind(12)}重播</button>
          <button data-a="speed" class="toggle" title="0.5 倍速播放">0.5X</button>
          <button data-a="orientation" class="toggle on" title="切换为竖版下落式布局：时间轴纵向滚动，轨道头在下方，波形图在右侧">竖版</button>
          <div class="sep"></div>
          <label>缩放</label>
          <input data-a="zoom" type="range" min="1" max="1200" value="60" />
          <div class="sep"></div>
          <button data-a="tpAdd" class="btn" title="在播放头位置创建一个 BPM 变速点">${ICONS.plus(14)}增加BPM点</button>
          <button data-a="tpDel" class="btn" title="删除选中的 BPM 变速点">${ICONS.minus(14)}删除BPM点</button>
          <label>BPM</label>
          <input data-a="bpm" type="text" />
          <label>BPM偏移</label>
          <input data-a="bias" type="range" min="-0.5" max="0.5" step="0.001" value="0" style="width:80px" />
          <input data-a="biasText" type="text" style="width:44px" />
          <div class="sep"></div>
          <button data-a="snap" class="toggle on" title="创建/拖拽音符时自动吸附到节拍网格">音符吸附</button>
          <button data-a="grid" class="toggle on" title="显示节拍网格线">节拍网格</button>
          <button data-a="triplet" class="toggle" title="节拍细分切换为三连音（3等分），默认是二分/四分/八分">三连音</button>
          <button data-a="metro" class="toggle" title="播放时按节拍打点提示音">♩ 节拍器</button>
          <button data-a="noteCue" class="toggle on" title="播放时经过音符发出提示音，关闭则听不到音符声音">♪ 音符提示音</button>
          <div class="sep"></div>
          <label>天空配置</label>
          <select data-a="sky"></select>
          <div class="grow"></div>
          <span class="status" data-a="status"></span>
          <button data-a="save" class="btn btn-primary">${ICONS.save(14)}保存谱面</button>
          <button data-a="importMcz" class="btn" title="从 Malody 谱面包（.mcz）导入音符到当前谱面">${ICONS.upload(14)}导入MCZ</button>
          <button data-a="help" class="btn">${ICONS.book(14)}操作教程</button>
        </div>
        <div id="chartCanvasWrap">
          <canvas data-a="canvas"></canvas>
          <div class="chart-help hidden" data-a="help-panel">
            <div class="chart-help-title">指南</div>
            <h4>键盘</h4>
            <div class="help-grid">
              <span class="key">Space</span><span class="desc">播放/暂停</span>
              <span class="key">F（播放中）</span><span class="desc">打点录制</span>
              <span class="key">D</span><span class="desc">切换轻/重音符</span>
              <span class="key">Delete</span><span class="desc">删除选中</span>
              <span class="key">Ctrl+A</span><span class="desc">全选</span>
              <span class="key">Ctrl+C/V</span><span class="desc">复制粘贴</span>
              <span class="key">Ctrl+Z</span><span class="desc">撤销</span>
              <span class="key">Ctrl+S</span><span class="desc">保存</span>
            </div>
            <h4>鼠标</h4>
            <div class="help-grid">
              <span class="key">拖拽</span><span class="desc">框选</span>
              <span class="key">双击</span><span class="desc">建 Tap</span>
              <span class="key">Alt+拖拽</span><span class="desc">建 Hold</span>
              <span class="key">Ctrl+拖拽</span><span class="desc">跨轨移动</span>
              <span class="key">Shift+拖拽</span><span class="desc">调整 Hold 长度</span>
              <span class="key">右键拖</span><span class="desc">定位播放头</span>
              <span class="key">中键拖</span><span class="desc">平移</span>
              <span class="key">Ctrl/Alt+滚轮</span><span class="desc">缩放</span>
            </div>
          </div>
          <div class="chart-help hidden" data-a="empty-panel" style="left:8px;right:auto;width:260px;text-align:center;">
            该难度还没有谱面文件<br/><br/>
            <button data-a="createChart" class="btn btn-primary">+ 新建谱面</button>
          </div>
        </div>
      </div>`;

    this.el = {
      canvas: this.root.querySelector('[data-a="canvas"]'),
      wrap: this.root.querySelector("#chartCanvasWrap"),
      play: this.root.querySelector('[data-a="play"]'),
      stop: this.root.querySelector('[data-a="stop"]'),
      speed: this.root.querySelector('[data-a="speed"]'),
      orientation: this.root.querySelector('[data-a="orientation"]'),
      zoom: this.root.querySelector('[data-a="zoom"]'),
      tpAdd: this.root.querySelector('[data-a="tpAdd"]'),
      tpDel: this.root.querySelector('[data-a="tpDel"]'),
      bpm: this.root.querySelector('[data-a="bpm"]'),
      bias: this.root.querySelector('[data-a="bias"]'),
      biasText: this.root.querySelector('[data-a="biasText"]'),
      snap: this.root.querySelector('[data-a="snap"]'),
      grid: this.root.querySelector('[data-a="grid"]'),
      triplet: this.root.querySelector('[data-a="triplet"]'),
      metro: this.root.querySelector('[data-a="metro"]'),
      noteCue: this.root.querySelector('[data-a="noteCue"]'),
      sky: this.root.querySelector('[data-a="sky"]'),
      status: this.root.querySelector('[data-a="status"]'),
      save: this.root.querySelector('[data-a="save"]'),
      importMcz: this.root.querySelector('[data-a="importMcz"]'),
      help: this.root.querySelector('[data-a="help"]'),
      helpPanel: this.root.querySelector('[data-a="help-panel"]'),
      emptyPanel: this.root.querySelector('[data-a="empty-panel"]'),
      createChart: this.root.querySelector('[data-a="createChart"]'),
    };
    this.ctx = this.el.canvas.getContext("2d");

    for (let i = 0; i < SKY_PRESETS.length; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `${SKY_PRESETS[i].name}  T${SKY_PRESETS[i].timeOfDay.toFixed(1)}`;
      this.el.sky.appendChild(opt);
    }
    const noneOpt = document.createElement("option");
    noneOpt.value = "-1";
    noneOpt.textContent = "";
    this.el.sky.appendChild(noneOpt);
    this.el.sky.value = "-1";

    // The canvas's CSS box is 100%-of-wrap purely via CSS (see #chartCanvas in
    // app.css) — dragging a window edge resizes it live with zero JS involvement,
    // same as any other element, so there's nothing here that can run away during
    // the drag itself. The only JS work is reallocating the drawing-buffer pixels
    // and redrawing, which is comparatively expensive and doesn't need to happen on
    // every one of the many `resize` events a drag fires — so it's debounced to run
    // once, ~150ms after the last event (i.e. once the drag has actually stopped).
    this._resizeDebounce = null;
    this._onWindowResize = () => {
      if (!this.active) return;
      clearTimeout(this._resizeDebounce);
      this._resizeDebounce = setTimeout(() => {
        if (!this.active) return;
        this._resize();
        this._redraw();
      }, 150);
    };
    window.addEventListener("resize", this._onWindowResize);
  }

  _wireEvents() {
    const el = this.el;
    el.play.addEventListener("click", () => this.togglePlay());
    el.stop.addEventListener("click", () => {
      this.playing = false;
      this._stopRaf();
      this._waStopInternal();
      this.playhead = 0;
      if (this.orientation === "vertical") this._relockScroll();
      this._redraw();
    });
    el.speed.addEventListener("click", () => {
      this.playbackRate = this.playbackRate === 1 ? 0.5 : 1;
      this._waSetRate(this.playbackRate);
      el.speed.classList.toggle("on", this.playbackRate === 0.5);
    });
    el.orientation.addEventListener("click", () => {
      this.orientation = this.orientation === "vertical" ? "horizontal" : "vertical";
      el.orientation.classList.toggle("on", this.orientation === "vertical");
      this.wavCache = null;
      this._resize();
      if (this.orientation === "vertical") this._relockScroll();
      this._redraw();
    });
    el.zoom.addEventListener("input", () => {
      this.pps = clamp(parseFloat(el.zoom.value), this._minPps(), 1200);
      this.wavCache = null;
      this._redraw();
    });
    el.tpAdd.addEventListener("click", () => {
      const prev = this._activeTimingAt(this.playhead);
      const tp = { startTime: this.playhead, bpm: prev && prev.bpm > 0 ? prev.bpm : 120, offset: prev ? prev.offset : 0 };
      this.timingPoints.push(tp);
      this.timingPoints.sort((a, b) => a.startTime - b.startTime);
      this._selectTp(tp);
      this._redraw();
    });
    el.tpDel.addEventListener("click", () => {
      if (!this.selectedTp) return;
      this.timingPoints = this.timingPoints.filter((t) => t !== this.selectedTp);
      this.selectedTp = null;
      this._redraw();
    });
    el.bpm.addEventListener("change", () => {
      if (!this.selectedTp) return;
      const v = parseFloat(el.bpm.value);
      if (Number.isFinite(v) && v > 0) this.selectedTp.bpm = v;
      this._redraw();
    });
    el.bias.addEventListener("input", () => {
      if (!this.selectedTp) return;
      this.selectedTp.offset = parseFloat(el.bias.value);
      el.biasText.value = this.selectedTp.offset.toFixed(3);
      this._redraw();
    });
    el.biasText.addEventListener("change", () => {
      if (!this.selectedTp) return;
      const v = parseFloat(el.biasText.value);
      if (Number.isFinite(v)) {
        this.selectedTp.offset = clamp(v, -0.5, 0.5);
        el.bias.value = String(this.selectedTp.offset);
      }
      this._redraw();
    });
    el.snap.addEventListener("click", () => {
      this.snapEnabled = !this.snapEnabled;
      el.snap.classList.toggle("on", this.snapEnabled);
    });
    el.grid.addEventListener("click", () => {
      this.showBeatGrid = !this.showBeatGrid;
      el.grid.classList.toggle("on", this.showBeatGrid);
      this._redraw();
    });
    el.triplet.addEventListener("click", () => {
      this.tripletGrid = !this.tripletGrid;
      el.triplet.classList.toggle("on", this.tripletGrid);
      this._redraw();
    });
    el.metro.addEventListener("click", () => {
      this.metronome = !this.metronome;
      el.metro.classList.toggle("on", this.metronome);
    });
    el.noteCue.addEventListener("click", () => {
      this.noteCue = !this.noteCue;
      el.noteCue.classList.toggle("on", this.noteCue);
    });
    el.sky.addEventListener("change", () => {
      if (!this.selectedSky) return;
      const idx = parseInt(el.sky.value, 10);
      if (idx < 0) return;
      const preset = SKY_PRESETS[idx];
      Object.assign(this.selectedSky, {
        timeOfDay: preset.timeOfDay, cloudScale: preset.cloudScale,
        cloudDensity: preset.cloudDensity, cloudHeight: preset.cloudHeight,
      });
      this._redraw();
    });
    el.save.addEventListener("click", () => this.save());
    el.importMcz.addEventListener("click", () => this._importMcz());
    el.help.addEventListener("click", () => el.helpPanel.classList.toggle("hidden"));
    el.createChart.addEventListener("click", () => this._createChart());

    const c = el.canvas;
    c.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    c.addEventListener("pointermove", (e) => this._onPointerMove(e));
    c.addEventListener("pointerup", (e) => this._onPointerUp(e));
    c.addEventListener("dblclick", (e) => this._onDblClick(e));
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    this.root.addEventListener("keydown", (e) => this._onKeyDown(e));
    this.root.tabIndex = -1;
  }

  // ── Public API ────────────────────────────────────────────────────────
  async loadSong(song) {
    this.playing = false;
    this._waStopInternal();
    this._stopRaf();
    this.song = song;
    this.trackCount = song.trackCount || 8;
    this.selectedNotes.clear();
    this.selectedTp = null;
    this.selectedSky = null;
    this.el.sky.value = "-1";
    this.playhead = 0;
    this.audioBuffer = null;
    this.wavCache = null;

    const chart = await bridge.call("loadChart", { folder: song.folder, difficulty: this.difficulty });
    this.exists = chart.exists;
    this.rate = chart.rate;
    const parsed = parseCsv(chart.exists ? chart.csv : EMPTY_CSV_HEADER);
    this.notes = parsed.notes;
    this.timingPoints = parsed.timingPoints;
    this.skyPoints = parsed.skyPoints;
    if (this.timingPoints.length > 0) this._selectTp(this.timingPoints[0]);

    this.el.emptyPanel.classList.toggle("hidden", this.exists);
    this._updateStatus();

    if (song.audioUrl) {
      try {
        const buf = await fetch(song.audioUrl).then((r) => r.arrayBuffer());
        const ctx = this._ensureAudioCtx();
        this.audioBuffer = await ctx.decodeAudioData(buf);
        this.audioDuration = this.audioBuffer.duration;
      } catch {
        this.audioDuration = 60;
      }
    } else {
      this.audioDuration = 60;
    }

    this._settleSize();
  }

  setActive(active) {
    this.active = active;
    if (!active) {
      this.playing = false;
      this._waStopInternal();
      this._stopRaf();
    } else {
      this._settleSize();
    }
  }

  // A tab-panel going display:none -> flex (or a song just finishing load) can settle
  // its layout one frame later than the synchronous call below observes. This does the
  // synchronous measurement immediately, then ONE extra rAF-later correction — not a
  // recurring observer — so a single late layout tick can't be mistaken for real growth.
  _settleSize() {
    this._resize();
    this._redraw();
    requestAnimationFrame(() => {
      if (this.active) {
        this._resize();
        this._redraw();
      }
    });
  }

  async _createChart() {
    if (!this.song) return;
    try {
      await bridge.call("saveChart", { folder: this.song.folder, difficulty: this.difficulty, rate: this.rate || 1, csv: EMPTY_CSV_HEADER });
      toast(`${difficultyLabel(this.difficulty)}谱面已创建`);
      await this.loadSong(this.song);
    } catch (err) {
      toast(String(err.message || err), true);
    }
  }

  async save() {
    if (!this.song) return;
    const csv = serializeCsv(this.notes, this.timingPoints, this.skyPoints);
    try {
      await bridge.call("saveChart", { folder: this.song.folder, difficulty: this.difficulty, rate: this.rate || 1, csv });
      this.exists = true;
      toast(`${difficultyLabel(this.difficulty)}谱面已保存 (${this.notes.length} 音符)`);
      this._updateStatus();
    } catch (err) {
      toast(String(err.message || err), true);
    }
  }

  async _importMcz() {
    if (!this.song) return;
    const mczPath = await bridge.call("pickMczFile");
    if (!mczPath) return;
    const mode = await openMczModeModal();
    if (mode === null) return;

    let result;
    try {
      result = await bridge.call("importMcz", { mczPath, mode });
    } catch (err) {
      toast(String(err.message || err), true);
      return;
    }

    if (this.notes.length > 0) {
      const ok = await confirmDialog(
        `当前谱面已有 ${this.notes.length} 个音符，导入会整体替换所有音符和 BPM 点。确定继续吗？`,
        { title: "导入 MCZ", confirmText: "替换", danger: true },
      );
      if (!ok) return;
    }

    this.selectedNotes.clear();
    this.selectedTp = null;
    this.selectedSky = null;
    this.notes = result.notes.map((n) => ({ track: n.track, startTime: n.startTime, endTime: n.endTime, category: n.category }));
    this.timingPoints = result.timingPoints.map((t) => ({ startTime: t.startTime, bpm: t.bpm, offset: t.offset }));
    this.notes.sort((a, b) => a.startTime - b.startTime);
    this.timingPoints.sort((a, b) => a.startTime - b.startTime);
    if (this.timingPoints.length > 0) this._selectTp(this.timingPoints[0]);
    this.undoSnapshot = null;
    this._redraw();

    let msg = `已从 mcz 导入 ${this.notes.length} 个音符`;
    if (result.warnings && result.warnings.length) msg += "；" + result.warnings.join("；");
    toast(msg);

    await this.save();
  }

  destroy() {
    this._stopRaf();
    this._waStopInternal();
    clearTimeout(this._resizeDebounce);
    window.removeEventListener("resize", this._onWindowResize);
  }

  // ── Geometry ──────────────────────────────────────────────────────────
  // Matches the original tool's Duration property: once audio is loaded its length is
  // authoritative, full stop — notes are never allowed to inflate the timeline past the
  // real waveform data (that's what was producing the "stretch" near the very end: the
  // scrollbar/view could extend a few seconds past audioDuration into a region with no
  // real samples, where the waveform cache has to compress what little data exists to
  // fill the remaining pixel width).
  get duration() {
    if (this.audioBuffer) return this.audioDuration;
    return this.notes.length ? Math.max(...this.notes.map((n) => n.endTime)) + 5 : 60;
  }
  _minPps() {
    return Math.max(1, (this._canvasCssW - HEADER_WIDTH) / Math.max(this.duration, 1));
  }
  _timeToX(t) {
    return HEADER_WIDTH + t * this.pps - this.scrollX;
  }
  _xToTime(x) {
    return (x - HEADER_WIDTH + this.scrollX) / this.pps;
  }
  _trackIdxOf(track) {
    return TRACKS.indexOf(track);
  }
  _isTrackActive(track) {
    const tier = TRACK_TIERS[track];
    return tier === undefined || tier <= this.trackCount;
  }
  _trackY(idx) {
    let y = 0;
    for (let i = 0; i < idx; i++) y += this._trackHeights[i];
    return y;
  }
  _noteMargin(track) {
    return Math.max(1, Math.round(baseNoteMargin(track) * this._laneScale));
  }
  _yToTrackIdx(canvasY) {
    const relY = canvasY - this._timelineRect.y;
    if (relY < 0) return -1;
    let cum = 0;
    for (let i = 0; i < TRACKS.length; i++) {
      cum += this._trackHeights[i];
      if (relY < cum) return i;
    }
    return -1;
  }
  _activeTimingAt(t) {
    let result = null;
    for (const tp of this.timingPoints) {
      if (tp.startTime <= t) result = tp;
      else break;
    }
    return result;
  }
  _snapped(t) {
    if (!this.snapEnabled) return t;
    const tp = this._activeTimingAt(t);
    if (!tp || tp.bpm <= 0) return t;
    const interval = 60 / tp.bpm / 8;
    return tp.offset + Math.round((t - tp.offset) / interval) * interval;
  }
  _selectTp(tp) {
    this.selectedTp = tp;
    if (tp) {
      this.el.bpm.value = tp.bpm > 0 ? tp.bpm.toFixed(1) : "";
      this.el.bias.value = String(tp.offset);
      this.el.biasText.value = tp.offset.toFixed(3);
    }
  }

  // Everything below (drawing, hit-testing, dragging) is written once, in a single
  // "logical" space that's always horizontal-native: logical-x is the time axis,
  // logical-y is the track axis, exactly as if orientation were always "horizontal".
  // Vertical mode reuses all of that unchanged — it only swaps what _canvasCssW/H
  // (the logical bounds) resolve to, and rotates the canvas transform so logical-x
  // (time) ends up running bottom→top on screen and logical-y (tracks) left→right.
  // _canvasPoint() applies the matching inverse so pointer input lands back in the
  // same logical space every interaction handler already expects.
  _resize() {
    const dpr = window.devicePixelRatio || 1;
    // Read-only measurement — the canvas's own CSS box comes purely from `inset:0`
    // in app.css, so nothing here ever writes a size back onto the canvas element.
    const rect = this.el.wrap.getBoundingClientRect();
    const realW = Math.max(200, Math.round(rect.width));
    const realH = Math.max(200, Math.round(rect.height));
    this.el.canvas.width = Math.round(realW * dpr);
    this.el.canvas.height = Math.round(realH * dpr);

    const vertical = this.orientation === "vertical";
    const w = vertical ? realH : realW;
    const h = vertical ? realW : realH;
    this._canvasCssW = w;
    this._canvasCssH = h;
    if (vertical) this.ctx.setTransform(0, -dpr, dpr, 0, 0, w * dpr);
    else this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Sky lane + the 10 note tracks scale together to fill whatever vertical space is
    // left after the waveform strip and scrollbar, which stay a fixed pixel height.
    const availableForLanes = Math.max(60, h - WAVEFORM_H - SCROLLBAR_H);
    this._laneScale = availableForLanes / (BASE_SKY_LANE_H + BASE_TRACKS_TOTAL_H);
    this._skyLaneH = Math.max(8, Math.round(BASE_SKY_LANE_H * this._laneScale));
    this._trackHeights = TRACKS.map((t) => Math.max(10, Math.round(baseTrackH(t) * this._laneScale)));
    // Rounding each lane independently can leave a 1-2px gap or overlap — absorb the
    // drift into the last lane so the stack exactly fills availableForLanes.
    const usedH = this._skyLaneH + this._trackHeights.reduce((a, b) => a + b, 0);
    this._trackHeights[this._trackHeights.length - 1] += availableForLanes - usedH;
    this._tracksTotalH = this._trackHeights.reduce((a, b) => a + b, 0);

    this._skyLaneRect = { y: 0, h: this._skyLaneH };
    this._timelineRect = { y: this._skyLaneH, h: this._tracksTotalH };
    this._waveformRect = { y: this._skyLaneH + this._tracksTotalH, h: WAVEFORM_H };
    this._scrollbarRect = { y: this._skyLaneH + this._tracksTotalH + WAVEFORM_H, h: SCROLLBAR_H };
    this.pps = clamp(this.pps, this._minPps(), 1200);
    if (this.orientation === "vertical") {
      // A plain window resize changes _canvasCssW same as an orientation flip does —
      // the lock invariant has to survive that too, so re-derive scrollX from playhead
      // rather than just clamping whatever it currently is.
      this._relockScroll();
    } else {
      // A resize can strand scrollX past the new maximum — pps above already gets its
      // own clamp, scrollX needs the matching one.
      const maxScroll = Math.max(0, this.duration * this.pps - (this._canvasCssW - HEADER_WIDTH));
      this.scrollX = clamp(this.scrollX, 0, maxScroll);
    }
  }

  _updateStatus() {
    const n = this.notes.length;
    this.el.status.textContent = this.song ? `${this.song.title || this.song.folder} · ${difficultyLabel(this.difficulty)} · ${n} 音符` : "";
  }

  // ── Drawing ───────────────────────────────────────────────────────────
  _redraw() {
    if (!this.active) return;
    this.el.play.innerHTML = (this.playing ? ICONS.pause(12) : ICONS.play(12)) + (this.playing ? "暂停" : "播放");

    // Keep the BPM/Bias fields (and the highlighted marker) in sync with whichever
    // timing point governs the current playhead position, mirroring the original tool.
    if (!this._dragTp) {
      const activeTp = this._activeTimingAt(this.playhead);
      if (activeTp && activeTp !== this.selectedTp) this._selectTp(activeTp);
    }

    const ctx = this.ctx;
    const w = this._canvasCssW, h = this._canvasCssH;
    ctx.clearRect(0, 0, w, h);

    this._drawSkyLane();
    this._drawTimeline();
    this._drawWaveform();
    this._drawPlayhead();
    this._drawScrollbar();
  }

  // The rotation baked into _resize()'s vertical-mode transform would otherwise turn
  // every fillText call sideways along with the shapes. Text needs to stay upright, so
  // every fillText in this file goes through here instead: translate to the logical
  // point (which the ambient transform already places correctly on screen) then apply
  // a local +90° rotation that exactly cancels the ambient -90° for this one call,
  // leaving position correct and orientation upright. No-op in horizontal mode.
  _fillTextUpright(text, lx, ly) {
    if (this.orientation !== "vertical") {
      this.ctx.fillText(text, lx, ly);
      return;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  _drawSkyLane() {
    // Blue reads unambiguously as "sky" and is distinct from both the orange accent and
    // the disabled-track gray, so this lane can't be mistaken for a grayed-out one.
    const ctx = this.ctx, area = this._skyLaneRect, w = this._canvasCssW;
    ctx.fillStyle = "rgb(24,34,54)";
    ctx.fillRect(0, area.y, w, area.h);
    ctx.fillStyle = "rgb(18,26,42)";
    ctx.fillRect(0, area.y, HEADER_WIDTH, area.h);
    ctx.fillStyle = "rgb(150,200,255)";
    ctx.font = "13px 'Segoe UI'";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    this._fillTextUpright("天空区", HEADER_WIDTH / 2, area.y + area.h / 2);

    for (const sp of this.skyPoints) {
      const x0 = this._timeToX(sp.startTime), x1 = this._timeToX(sp.endTime);
      if (x1 < HEADER_WIDTH || x0 > w) continue;
      const sel = sp === this.selectedSky;
      const dx0 = Math.max(x0, HEADER_WIDTH), dx1 = Math.min(x1, w);
      ctx.fillStyle = sel ? "rgba(110,180,255,.55)" : "rgba(70,140,220,.40)";
      ctx.fillRect(dx0, area.y + 2, Math.max(dx1 - dx0, 2), area.h - 4);
      ctx.fillStyle = sel ? "#fff" : "rgba(140,195,255,.9)";
      if (x0 >= HEADER_WIDTH) ctx.fillRect(x0, area.y, 2, area.h);
      if (x1 <= w) ctx.fillRect(x1 - 2, area.y, 2, area.h);
    }
    ctx.fillStyle = "rgb(13,13,13)";
    ctx.fillRect(0, area.y + area.h - 1, w, 1);
  }

  _drawTimeline() {
    const ctx = this.ctx, area = this._timelineRect, w = this._canvasCssW;
    ctx.fillStyle = "rgb(36,36,36)";
    ctx.fillRect(0, area.y, w, area.h);

    for (let i = 0; i < TRACKS.length; i++) {
      const track = TRACKS[i];
      const th = this._trackHeights[i];
      const y = area.y + this._trackY(i);
      const isRec = track === REC_TRACK, isHeavy = track === HEAVY_TRACK;
      const active = this._isTrackActive(track);

      let lane;
      if (!active) lane = "rgb(24,24,24)";
      else if (isRec) lane = "rgb(61,48,20)";
      else if (isHeavy) lane = "rgb(56,26,26)";
      else lane = i % 2 === 0 ? "rgb(43,43,43)" : "rgb(48,48,48)";
      ctx.fillStyle = lane;
      ctx.fillRect(HEADER_WIDTH, y, w - HEADER_WIDTH, th);

      if (!active) ctx.fillStyle = "rgb(20,20,20)";
      else ctx.fillStyle = isRec ? "rgb(140,82,10)" : isHeavy ? "rgb(115,26,26)" : "rgb(26,26,26)";
      ctx.fillRect(0, y, HEADER_WIDTH, th);
      if (!active) ctx.fillStyle = "rgb(80,78,74)";
      else ctx.fillStyle = isRec ? "rgb(255,230,77)" : isHeavy ? "rgb(255,89,89)" : "rgb(191,191,191)";
      ctx.font = "13px 'Segoe UI'";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      this._fillTextUpright(trackLabel(track), HEADER_WIDTH / 2, y + th / 2);

      ctx.fillStyle = "rgb(18,18,18)";
      ctx.fillRect(0, y + th - 1, w, 1);
    }

    // Everything from here on (grid lines, ruler labels, notes, box-select) scrolls with
    // the timeline and must never paint over the fixed header column — clip it out rather
    // than relying on every draw call to individually stay clear of x < HEADER_WIDTH (a
    // hold note or a wide box-select starting off-screen-left was bleeding under the
    // track-name labels before this).
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_WIDTH, area.y, w - HEADER_WIDTH, area.h);
    ctx.clip();

    if (this.showBeatGrid && this.timingPoints.length > 0) this._drawBeatGrid(area);
    this._drawRuler(area);
    this._drawTimingPoints(area);
    for (const note of this.notes) this._drawNote(note, area);

    if (this._boxSelecting) {
      const bx = Math.min(this._boxStart.x, this._boxCurrent.x);
      const by = Math.min(this._boxStart.y, this._boxCurrent.y);
      const bw = Math.abs(this._boxCurrent.x - this._boxStart.x);
      const bh = Math.abs(this._boxCurrent.y - this._boxStart.y);
      ctx.fillStyle = "rgba(255,122,26,.14)";
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = "rgba(255,122,26,.75)";
      ctx.fillRect(bx, by, bw, 1);
      ctx.fillRect(bx, by + bh - 1, bw, 1);
      ctx.fillRect(bx, by, 1, bh);
      ctx.fillRect(bx + bw - 1, by, 1, bh);
    }

    ctx.restore();
  }

  // Two passes, both phase-anchored on tp.offset like before:
  //  1. Beat lines, dark red, ALWAYS drawn — spacing adapts in powers of 2 (1, 2, 4, 8...
  //     beats) so there's always something legible on screen regardless of zoom, instead
  //     of the grid disappearing once a fixed subdivision gets too dense to draw.
  //  2. Sub-beat subdivisions — binary (halves down to 1/8 beat) or triplet (thirds down
  //     to 1/6 beat) depending on the toggle — only drawn once they're legible; the beat
  //     lines above are always there as the fallback, so this can simply skip itself at
  //     low zoom rather than needing its own "never disappear" handling.
  _drawBeatGrid(area) {
    const ctx = this.ctx;
    const viewStart = this._xToTime(HEADER_WIDTH);
    const viewEnd = this._xToTime(this._canvasCssW);
    const MIN_PX_BEAT = 8;
    const MIN_PX_FINE = 3;
    for (let ti = 0; ti < this.timingPoints.length; ti++) {
      const tp = this.timingPoints[ti];
      if (tp.bpm <= 0) continue;
      const segStart = tp.startTime;
      const segEnd = ti + 1 < this.timingPoints.length ? this.timingPoints[ti + 1].startTime : viewEnd + 1;
      if (segEnd < viewStart || segStart > viewEnd) continue;
      const beatDur = 60 / tp.bpm;
      const drawStart = Math.max(segStart, viewStart), drawEnd = Math.min(segEnd, viewEnd);

      // Pass 1: beat lines.
      const rawStep = MIN_PX_BEAT / (beatDur * this.pps);
      const beatStep = rawStep <= 1 ? 1 : Math.pow(2, Math.ceil(Math.log2(rawStep)));
      const beatUnit = beatDur * beatStep;
      const b0 = Math.floor((drawStart - tp.offset) / beatUnit);
      const b1 = Math.ceil((drawEnd - tp.offset) / beatUnit) + 1;
      for (let i = b0; i <= b1; i++) {
        const t = tp.offset + i * beatUnit;
        if (t < segStart - 0.0001 || t > segEnd + 0.0001) continue;
        const x = this._timeToX(t);
        if (x < HEADER_WIDTH) continue;
        ctx.fillStyle = "rgba(180,45,45,.8)";
        ctx.fillRect(x, area.y, 1, area.h);
      }

      // Pass 2: sub-beat subdivisions.
      const divs = this.tripletGrid ? 6 : 8;
      const fineUnit = beatDur / divs;
      if (fineUnit * this.pps < MIN_PX_FINE) continue;
      const i0 = Math.floor((drawStart - tp.offset) / fineUnit);
      const i1 = Math.ceil((drawEnd - tp.offset) / fineUnit) + 1;
      for (let i = i0; i <= i1; i++) {
        const sub = ((i % divs) + divs) % divs;
        if (sub === 0) continue; // on-beat — pass 1 above already drew this one, in red
        const t = tp.offset + i * fineUnit;
        if (t < segStart - 0.0001 || t > segEnd + 0.0001) continue;
        const x = this._timeToX(t);
        if (x < HEADER_WIDTH) continue;
        if (this.tripletGrid) ctx.fillStyle = sub === 2 || sub === 4 ? "rgba(122,122,122,.65)" : "rgba(71,71,71,.35)";
        else ctx.fillStyle = sub === 4 ? "rgba(122,122,122,.65)" : sub === 2 || sub === 6 ? "rgba(92,92,92,.5)" : "rgba(71,71,71,.35)";
        ctx.fillRect(x, area.y, 1, area.h);
      }
    }
  }

  _bestRulerStep() {
    const target = 70;
    const tp = this._activeTimingAt(this._xToTime(this._canvasCssW * 0.5)) || this.timingPoints[0] || null;
    if (tp && tp.bpm > 0) {
      const beat = 60 / tp.bpm;
      for (const m of [0.25, 0.5, 1, 2, 4, 8, 16, 32]) if (m * beat * this.pps >= target) return m * beat;
      return 32 * beat;
    }
    for (const s of [0.0625, 0.125, 0.25, 0.5, 1, 2, 5, 10, 30]) if (s * this.pps >= target) return s;
    return 30;
  }

  _formatTime(t) {
    const tp = this._activeTimingAt(t) || this.timingPoints[0] || null;
    if (tp && tp.bpm > 0) {
      const beat = 60 / tp.bpm;
      const beatNum = (t - tp.offset) / beat;
      const whole = Math.floor(beatNum);
      const frac = beatNum - whole;
      const fStr = frac > 0.4 && frac < 0.6 ? ".5" : "";
      return `♩${whole + 1}${fStr}`;
    }
    return t < 60 ? `${t.toFixed(2)}s` : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
  }

  _drawRuler(area) {
    const ctx = this.ctx;
    const step = this._bestRulerStep();
    const startT = this._xToTime(HEADER_WIDTH), endT = this._xToTime(this._canvasCssW);
    const i0 = Math.floor(startT / step), i1 = Math.ceil(endT / step) + 1;
    const hasBpm = this.timingPoints.some((tp) => tp.bpm > 0);
    ctx.font = "9px 'Segoe UI'";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (let i = i0; i <= i1; i++) {
      const t = i * step;
      const x = this._timeToX(t);
      if (x < HEADER_WIDTH) continue;
      if (!hasBpm) {
        ctx.fillStyle = "rgb(71,71,71)";
        ctx.fillRect(x, area.y, 1, area.h);
      }
      ctx.fillStyle = "rgb(166,166,166)";
      this._fillTextUpright(this._formatTime(t), x + 2, area.y);
    }
  }

  _drawTimingPoints(area) {
    const ctx = this.ctx;
    for (const tp of this.timingPoints) {
      const x = this._timeToX(tp.startTime);
      if (x < HEADER_WIDTH || x > this._canvasCssW) continue;
      const sel = tp === this.selectedTp;
      ctx.fillStyle = sel ? "rgba(255,255,255,.95)" : "rgba(255,191,51,.85)";
      ctx.fillRect(x - 1, area.y, 3, area.h);
      ctx.fillRect(x - 3, area.y, 7, 5);
    }
  }

  _drawNote(note, area) {
    const idx = this._trackIdxOf(note.track);
    if (idx < 0) return;
    const x = this._timeToX(note.startTime);
    const nm = this._noteMargin(note.track);
    const y = area.y + this._trackY(idx) + nm;
    const h = this._trackHeights[idx] - nm * 2;
    const c = categoryColor(note.category);
    const sel = this.selectedNotes.has(note);
    const ctx = this.ctx;

    if (isHold(note)) {
      const endX = this._timeToX(note.endTime);
      const w = Math.max(endX - x, 5);
      ctx.fillStyle = c.replace("rgb", "rgba").replace(")", ",.45)");
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = c;
      ctx.fillRect(x, y, 2, h);
      ctx.fillRect(x + w - 2, y, 2, h);
      if (sel) this._drawSelBorder(x, y, w, h);
    } else {
      const w = Math.max(this.pps * 0.02, 4);
      const nx = x - w / 2;
      ctx.fillStyle = c;
      ctx.fillRect(nx, y, w, h);
      if (sel) this._drawSelBorder(nx, y, w, h);
    }
  }

  _drawSelBorder(x, y, w, h) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(255,255,255,.9)";
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y, 1, h);
    ctx.fillRect(x + w - 1, y, 1, h);
  }

  _drawWaveform() {
    const ctx = this.ctx, area = this._waveformRect, w = this._canvasCssW;
    ctx.fillStyle = "rgb(23,23,23)";
    ctx.fillRect(0, area.y, w, area.h);
    ctx.fillStyle = "rgb(115,115,115)";
    ctx.font = "9px 'Segoe UI'";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    this._fillTextUpright(this.song?.title || "No Audio", 12, area.y + 10);
    if (!this.audioBuffer) return;

    const drawW = Math.floor(w - HEADER_WIDTH);
    if (drawW <= 0) return;

    if (!this.wavCache || this.wavCache.w !== drawW || this.wavCache.pps !== this.pps || this.wavCache.scrollX !== this.scrollX) {
      this._buildWaveCache(drawW);
    }
    const { min, max } = this.wavCache;
    const midY = area.y + area.h * 0.5;
    const ampScale = area.h * 0.46;
    ctx.fillStyle = "rgba(255,122,26,.9)";
    for (let px = 0; px < drawW && px < min.length; px++) {
      const topY = midY - max[px] * ampScale;
      const botY = midY - min[px] * ampScale;
      ctx.fillRect(HEADER_WIDTH + px, topY, 1, Math.max(1, botY - topY));
    }
    ctx.fillStyle = "rgb(77,77,77)";
    ctx.fillRect(HEADER_WIDTH, midY, w - HEADER_WIDTH, 1);
  }

  _buildWaveCache(drawW) {
    const buf = this.audioBuffer;
    const data = buf.getChannelData(0);
    const total = data.length;
    const startT = this._xToTime(HEADER_WIDTH);
    const endT = startT + drawW / this.pps;
    const s0 = clamp(Math.floor(startT * buf.sampleRate), 0, total - 1);
    const s1 = clamp(Math.floor(endT * buf.sampleRate), 0, total);
    const count = s1 - s0;
    const min = new Float32Array(drawW), max = new Float32Array(drawW);
    if (count > 0) {
      for (let px = 0; px < drawW; px++) {
        let a = s0 + Math.floor((px / drawW) * count);
        let b = s0 + Math.floor(((px + 1) / drawW) * count);
        a = clamp(a, 0, total - 1);
        b = clamp(b, 0, total);
        let mn = 0, mx = 0;
        for (let s = a; s < b; s++) {
          const v = data[s];
          if (v > mx) mx = v;
          if (v < mn) mn = v;
        }
        min[px] = mn;
        max[px] = mx;
      }
    }
    this.wavCache = { min, max, w: drawW, pps: this.pps, scrollX: this.scrollX };
  }

  _drawPlayhead() {
    const x = this._timeToX(this.playhead);
    if (x < HEADER_WIDTH || x > this._canvasCssW) return;
    const ctx = this.ctx;
    const top = 0, bottom = this._skyLaneH + this._tracksTotalH + WAVEFORM_H;
    ctx.fillStyle = "rgba(255,56,56,.9)";
    ctx.fillRect(x - 1, top, 2, bottom - top);
    ctx.fillStyle = "rgb(255,77,77)";
    ctx.font = "bold 9px 'Segoe UI'";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    this._fillTextUpright(this._formatTime(this.playhead), x + 3, bottom);
  }

  _drawScrollbar() {
    const ctx = this.ctx, area = this._scrollbarRect, w = this._canvasCssW;
    const dur = Math.max(this.duration, 1);
    const visibleW = w - HEADER_WIDTH;
    const visStart = this.scrollX / this.pps;
    const visEnd = (this.scrollX + visibleW) / this.pps;
    const barW = w;

    // The center segment maps 1:1 to the visible time window, but within a track
    // *inset* by one handle width on each side — not the full barW — so there's
    // always physical room for a full handle outside the center without clamping it
    // into an overlap, even at the very start/end of the timeline at max zoom.
    const usableW = Math.max(1, barW - HANDLE_W * 2);
    const centerX = HANDLE_W + (visStart / dur) * usableW;
    const centerW = Math.min(Math.max(4, ((visEnd - visStart) / dur) * usableW), usableW - (centerX - HANDLE_W));
    const leftHandleX = centerX - HANDLE_W;
    const rightHandleX = centerX + centerW;

    // Dark track, with the thumb inset top/bottom into a slimmer pill rather than a
    // flat full-height gray-on-gray bar, and a faint accent tint on the edge handles.
    ctx.fillStyle = "rgb(15,15,15)";
    ctx.fillRect(0, area.y, w, area.h);
    ctx.fillStyle = "rgb(9,9,9)";
    ctx.fillRect(0, area.y, w, 1);

    const inset = 3;
    const thumbY = area.y + inset;
    const thumbH = area.h - inset * 2;
    ctx.fillStyle = "rgb(52,49,45)";
    ctx.fillRect(centerX, thumbY, centerW, thumbH);
    ctx.fillStyle = "rgba(255,150,60,.55)";
    ctx.fillRect(leftHandleX, thumbY, HANDLE_W, thumbH);
    ctx.fillRect(rightHandleX, thumbY, HANDLE_W, thumbH);

    this._scrollbarGeom = { centerX, centerW, leftHandleX, rightHandleX, barW, usableW };
  }

  // Vertical mode's playhead is pinned at the header — this recomputes the scrollX
  // that keeps it there for the current this.playhead, clamped like every other
  // scrollX update so it still relaxes normally right at the very end of the song.
  _relockScroll() {
    const maxScroll = Math.max(0, this.duration * this.pps - (this._canvasCssW - HEADER_WIDTH));
    this.scrollX = clamp(this.playhead * this.pps, 0, maxScroll);
  }

  // ── Playback ──────────────────────────────────────────────────────────
  // Plays straight from the decoded AudioBuffer via Web Audio's sample-accurate
  // scheduling — no separate <audio> element, no its start/seek latency, no its
  // coarse currentTime. See _waPlay/_waStop/_waCurrentOffset below.
  togglePlay() {
    if (this.playing) {
      this.playing = false;
      this._waStop();
      this._stopRaf();
      return;
    }
    if (!this.audioBuffer) return;
    this.playing = true;
    this._prevPlayhead = this.playhead;
    this._blippedNotes.clear();
    this._waPlay(this.playhead);
    this._startRaf();
  }

  _startRaf() {
    const step = () => {
      if (!this.playing) return;
      const prev = this._prevPlayhead;
      this.playhead = this._waCurrentOffset();
      if (this._sourceEnded || this.playhead >= this.duration) {
        this.playing = false;
        this._waStopInternal();
        this.playhead = this.duration;
      }
      if (this.orientation === "vertical") {
        // Falling-note simulation: the red line stays pinned exactly at the header
        // instead of jumping only once it scrolls off-screen — the chart scrolls
        // continuously past it instead, every frame, for the whole song.
        this._relockScroll();
      } else {
        const phX = this._timeToX(this.playhead);
        if (phX < HEADER_WIDTH || phX > this._canvasCssW)
          this.scrollX = Math.max(0, this.playhead * this.pps - (this._canvasCssW - HEADER_WIDTH) * 0.25);
      }

      for (const note of this.notes) {
        if (!this._blippedNotes.has(note) && note.startTime > prev && note.startTime <= this.playhead) {
          this._blippedNotes.add(note);
          if (this.noteCue) beep(note.category === "Drums" ? 700 : 900, 0.05);
        }
      }
      if (this.metronome) {
        const mtp = this._activeTimingAt(this.playhead);
        if (mtp && mtp.bpm > 0) {
          const interval = 60 / mtp.bpm;
          const beatPrev = Math.floor((prev - mtp.offset) / interval);
          const beatNow = Math.floor((this.playhead - mtp.offset) / interval);
          for (let b = beatPrev + 1; b <= beatNow; b++) beep(1500, 0.06);
        }
      }
      this._prevPlayhead = this.playhead;
      this._redraw();
      if (this.playing) this._rafId = requestAnimationFrame(step);
    };
    this._rafId = requestAnimationFrame(step);
  }
  _stopRaf() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  // ── Web Audio playback ───────────────────────────────────────────────────
  _ensureAudioCtx() {
    return ChartEditor._audioCtx || (ChartEditor._audioCtx = new (window.AudioContext || window.webkitAudioContext)());
  }

  // Starts a fresh AudioBufferSourceNode at `offset` seconds into the buffer. A source
  // node can only ever be started once, so seeking/restarting always makes a new one.
  _waPlay(offset) {
    const ctx = this._ensureAudioCtx();
    this._waStopInternal();
    const source = ctx.createBufferSource();
    source.buffer = this.audioBuffer;
    source.playbackRate.value = this.playbackRate;
    source.connect(ctx.destination);
    source.onended = () => { this._sourceEnded = true; };
    source.start(0, Math.max(0, offset));
    this._sourceNode = source;
    this._sourceEnded = false;
    this._playStartCtxTime = ctx.currentTime;
    this._playStartOffset = Math.max(0, offset);
  }

  // Freezes this.playhead at the current computed position, then actually stops.
  _waStop() {
    this.playhead = this._waCurrentOffset();
    this._waStopInternal();
  }

  // Stops the node without touching this.playhead — used when the caller is about to
  // overwrite playhead itself (seeking) or is tearing down (song switch/destroy).
  _waStopInternal() {
    if (!this._sourceNode) return;
    this._sourceNode.onended = null;
    try { this._sourceNode.stop(); } catch { /* already stopped */ }
    this._sourceNode.disconnect();
    this._sourceNode = null;
  }

  // Sample-accurate playhead: derived from the audio hardware clock (audioContext.
  // currentTime), not a polled currentTime property, so it doesn't carry the coarse
  // update granularity an <audio> element has.
  _waCurrentOffset() {
    if (!this._sourceNode) return this.playhead;
    const ctx = ChartEditor._audioCtx;
    const elapsed = (ctx.currentTime - this._playStartCtxTime) * this._sourceNode.playbackRate.value;
    const raw = this._playStartOffset + elapsed;
    return this.audioBuffer ? Math.min(raw, this.audioBuffer.duration) : raw;
  }

  // playbackRate is a live AudioParam — no need to restart the node, just rebase the
  // offset/time reference point so future _waCurrentOffset() calls stay accurate.
  _waSetRate(rate) {
    if (!this._sourceNode) return;
    this._playStartOffset = this._waCurrentOffset();
    this._playStartCtxTime = ChartEditor._audioCtx.currentTime;
    this._sourceNode.playbackRate.value = rate;
  }

  // ── Hit testing ───────────────────────────────────────────────────────
  _hitTestNote(time, track) {
    const tol = RESIZE_ZONE_PX / this.pps;
    return this.notes.find((n) => n.track === track && time >= n.startTime - tol && time <= n.endTime + tol) || null;
  }
  _hitTestTp(time) {
    const tol = 6 / this.pps;
    return this.timingPoints.find((tp) => Math.abs(time - tp.startTime) <= tol) || null;
  }
  _hitTestSky(time) {
    const tol = RESIZE_ZONE_PX / this.pps;
    return this.skyPoints.find((sp) => time >= sp.startTime - tol && time <= sp.endTime + tol) || null;
  }

  // ── Undo ──────────────────────────────────────────────────────────────
  _saveUndo() {
    this.undoSnapshot = this.notes.map((n) => ({ ...n }));
  }
  _swapUndo() {
    if (!this.undoSnapshot) return;
    const current = this.notes.map((n) => ({ ...n }));
    this.notes = this.undoSnapshot.map((n) => ({ ...n }));
    this.selectedNotes.clear();
    this.notes.sort((a, b) => a.startTime - b.startTime);
    this.undoSnapshot = current;
  }

  // ── Pointer helpers ───────────────────────────────────────────────────
  // Inverse of the _resize() rotation: every interaction handler below works purely
  // in logical (horizontal-native) space, so real screen coordinates get mapped back
  // into it right here, once, rather than each handler knowing about orientation.
  _canvasPoint(e) {
    const r = this.el.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (this.orientation === "vertical") return { x: this._canvasCssW - sy, y: sx };
    return { x: sx, y: sy };
  }

  _onWheel(e) {
    e.preventDefault();
    const pt = this._canvasPoint(e);
    const vertical = this.orientation === "vertical";
    if (e.ctrlKey || e.altKey) {
      // Must be read before pps changes below — it's the time the old pps/scrollX
      // resolve pt.x to, used afterward to re-derive scrollX under the new pps.
      const pivot = vertical ? 0 : this._xToTime(pt.x);
      this.pps = clamp(this.pps * (1 - e.deltaY * 0.0012), this._minPps(), 1200);
      if (vertical) {
        // Always zooms anchored on the red line (the playhead) rather than the mouse
        // position — the header is a fixed invariant here, so there's no other point
        // that would keep it pinned.
        this._relockScroll();
      } else {
        const maxScroll = Math.max(0, this.duration * this.pps - (this._canvasCssW - HEADER_WIDTH));
        this.scrollX = clamp(pivot * this.pps - (pt.x - HEADER_WIDTH), 0, maxScroll);
      }
      this.wavCache = null;
    } else if (vertical) {
      this.playhead = clamp(this.playhead + (e.deltaY * 0.3) / this.pps, 0, this.duration);
      this._relockScroll();
    } else {
      const maxS = Math.max(0, this.duration * this.pps - (this._canvasCssW - HEADER_WIDTH));
      this.scrollX = clamp(this.scrollX + e.deltaY * 0.3, 0, maxS);
    }
    this._redraw();
  }

  _onDblClick(e) {
    if (e.altKey) return;
    const pt = this._canvasPoint(e);

    // Sky lane double-click → create a region. This used to be detected inside
    // pointerdown via e.detail >= 2, but PointerEvent's click-counting isn't reliable
    // for this — the real `dblclick` event (same one note creation below uses) is.
    if (this._skyLaneRect && pt.y < this._skyLaneRect.h) {
      const mouseTime = this._xToTime(pt.x);
      if (this._hitTestSky(mouseTime)) return;
      const t = Math.max(0, mouseTime);
      const preset = SKY_PRESETS[0];
      const created = {
        startTime: t, endTime: t + DEFAULT_SKY_DUR,
        timeOfDay: preset.timeOfDay, cloudScale: preset.cloudScale,
        cloudDensity: preset.cloudDensity, cloudHeight: preset.cloudHeight,
      };
      this.skyPoints.push(created);
      this.skyPoints.sort((a, b) => a.startTime - b.startTime);
      this.selectedSky = created;
      this.el.sky.value = "0";
      this._redraw();
      return;
    }

    if (!this._timelineRect || pt.y < this._timelineRect.y || pt.y > this._timelineRect.y + this._timelineRect.h) return;
    const trackIdx = this._yToTrackIdx(pt.y);
    if (trackIdx < 0) return;
    const track = TRACKS[trackIdx];
    if (!this._isTrackActive(track)) return;
    const mouseTime = this._xToTime(pt.x);
    if (this._hitTestNote(mouseTime, track)) return;
    this._boxSelecting = false;
    this._saveUndo();
    this.selectedNotes.clear();
    const t = this._snapped(mouseTime);
    const note = { track, startTime: t, endTime: t, category: track === HEAVY_TRACK ? HEAVY_CATEGORY : "Other" };
    this.notes.push(note);
    this.notes.sort((a, b) => a.startTime - b.startTime);
    this.selectedNotes.add(note);
    this._redraw();
  }

  _onPointerDown(e) {
    document.activeElement?.blur?.();
    this.root.focus();
    const pt = this._canvasPoint(e);

    // Scrollbar
    if (this._scrollbarRect && pt.y >= this._scrollbarRect.y && e.button === 0) {
      const g = this._scrollbarGeom;
      const sbx = pt.x;
      this._sbDragStartX = sbx;
      this._sbDragStartVisS = this.scrollX / this.pps;
      this._sbDragStartVisE = (this.scrollX + (this._canvasCssW - HEADER_WIDTH)) / this.pps;
      this._sbDragStartPlayhead = this.playhead;
      if (sbx >= g.leftHandleX && sbx <= g.leftHandleX + HANDLE_W) this._sbDrag = 1;
      else if (sbx >= g.rightHandleX && sbx <= g.rightHandleX + HANDLE_W) this._sbDrag = 3;
      else if (sbx >= g.centerX && sbx <= g.centerX + g.centerW) this._sbDrag = 2;
      else this._sbDrag = 0;
      if (this._sbDrag) { this.el.canvas.setPointerCapture(e.pointerId); return; }
    }

    // Middle button = pan
    if (e.button === 1) {
      e.preventDefault();
      this._panning = true;
      this._panLastX = pt.x;
      this.el.canvas.setPointerCapture(e.pointerId);
      return;
    }
    // Right button = seek. In vertical mode the red line is locked to the header —
    // this jump still targets wherever was clicked (same as horizontal), it's just the
    // chart that moves to bring that position under the line, not the line itself.
    if (e.button === 2) {
      this.playing = false;
      this._waStopInternal();
      this._stopRaf();
      this.playhead = clamp(this._xToTime(pt.x), 0, this.duration);
      this._seeking = true;
      this._seekLastX = pt.x;
      if (this.orientation === "vertical") this._relockScroll();
      this.el.canvas.setPointerCapture(e.pointerId);
      this._redraw();
      return;
    }
    if (e.button !== 0) return;

    // Sky lane
    if (pt.y < this._skyLaneRect.h) {
      this._handleSkyDown(pt, e);
      this.el.canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (pt.y < this._timelineRect.y || pt.y > this._timelineRect.y + this._timelineRect.h) return;

    const mouseTime = this._xToTime(pt.x);
    const trackIdx = this._yToTrackIdx(pt.y);
    if (trackIdx < 0) return;
    const track = TRACKS[trackIdx];

    const tpHit = this._hitTestTp(mouseTime);
    if (tpHit) {
      this._selectTp(tpHit);
      this._dragTp = tpHit;
      this._dragTpOffset = mouseTime - tpHit.startTime;
      this.el.canvas.setPointerCapture(e.pointerId);
      this._redraw();
      return;
    }

    // Lanes beyond the song's configured track count are grayed out and inert —
    // no selecting, dragging, or creating notes on them (timing points above are
    // exempt since they span the whole timeline, not a single lane).
    if (!this._isTrackActive(track)) return;

    const hit = this._hitTestNote(mouseTime, track);
    if (hit) {
      this._saveUndo();
      if (!e.shiftKey && !this.selectedNotes.has(hit)) this.selectedNotes.clear();
      this.selectedNotes.add(hit);
      this._dragNote = hit;
      const canResize = e.shiftKey && hit.track !== HEAVY_TRACK;
      this._dragResizing = canResize;
      this._dragOffset = canResize ? mouseTime - hit.endTime : mouseTime - hit.startTime;
      this.el.canvas.setPointerCapture(e.pointerId);
    } else if (e.altKey) {
      this._saveUndo();
      this.selectedNotes.clear();
      const t = this._snapped(mouseTime);
      const note = { track, startTime: t, endTime: t, category: track === HEAVY_TRACK ? HEAVY_CATEGORY : "Other" };
      this.notes.push(note);
      this.notes.sort((a, b) => a.startTime - b.startTime);
      this.selectedNotes.add(note);
      if (track !== HEAVY_TRACK) {
        this._dragNote = note;
        this._dragResizing = true;
        this._dragOffset = 0;
      }
      this.el.canvas.setPointerCapture(e.pointerId);
    } else {
      this.selectedNotes.clear();
      this._boxSelecting = true;
      this._boxStart = pt;
      this._boxCurrent = pt;
      this.el.canvas.setPointerCapture(e.pointerId);
    }
    this._redraw();
  }

  _handleSkyDown(pt, e) {
    const mouseTime = this._xToTime(pt.x);
    const edgeTol = RESIZE_ZONE_PX / this.pps;
    const hit = this._hitTestSky(mouseTime);
    if (hit) {
      this.selectedSky = hit;
      this._dragSky = hit;
      const presetIdx = findSkyPresetIndex(hit);
      this.el.sky.value = String(presetIdx);
      if (Math.abs(mouseTime - hit.startTime) <= edgeTol) this._dragSkyMode = 2;
      else if (Math.abs(mouseTime - hit.endTime) <= edgeTol) this._dragSkyMode = 3;
      else { this._dragSkyMode = 1; this._dragSkyOffset = mouseTime - hit.startTime; }
    } else {
      this.selectedSky = null;
      this.el.sky.value = "-1";
    }
    this._redraw();
  }

  _onPointerMove(e) {
    const pt = this._canvasPoint(e);

    if (this._sbDrag) {
      const dur = Math.max(this.duration, 1);
      const usableW = this._scrollbarGeom.usableW;
      const sbx = pt.x;
      // Exact inverse of the centerX(visStart) formula in _drawScrollbar — mapping the
      // mouse's absolute x straight back to a time value (rather than accumulating a
      // delta) guarantees the handle tracks the cursor exactly, with no room for the
      // forward/reverse math to drift apart by a fraction of a handle-width over a drag.
      const timeAtX = (x) => ((x - HANDLE_W) / usableW) * dur;
      let newVisS = this._sbDragStartVisS, newVisE = this._sbDragStartVisE;
      if (this._sbDrag === 1) {
        newVisS = clamp(timeAtX(sbx), 0, newVisE - 0.5);
      } else if (this._sbDrag === 3) {
        newVisE = clamp(timeAtX(sbx), newVisS + 0.5, dur);
      } else {
        // Panning the center — keep the visible window's width constant while clamping
        // it to [0, dur] instead of letting it drag past either end unboundedly.
        const delta = sbx - this._sbDragStartX;
        const deltaTime = (delta / usableW) * dur;
        const width = this._sbDragStartVisE - this._sbDragStartVisS;
        newVisS = this._sbDragStartVisS + deltaTime;
        newVisE = newVisS + width;
        if (newVisS < 0) { newVisS = 0; newVisE = width; }
        if (newVisE > dur) { newVisE = dur; newVisS = Math.max(0, dur - width); }
      }
      const visibleW = this._canvasCssW - HEADER_WIDTH;
      this.pps = clamp(visibleW / Math.max(newVisE - newVisS, 0.1), this._minPps(), 1200);
      if (this.orientation === "vertical") {
        // visStart tracks playhead under the lock, so a center-drag (pan) shifts
        // playhead by however much newVisS actually moved (post-clamp); a handle-drag
        // (zoom) leaves playhead where it is — either way _relockScroll() below is
        // what actually derives the final scrollX, not newVisS directly.
        if (this._sbDrag === 2) {
          // deltaTime here is an absolute offset from where the drag started, not a
          // per-event increment — it has to be added onto the FIXED playhead the drag
          // started at, not onto this.playhead as it currently stands (which already
          // includes every earlier event's shift). Compounding it onto a moving target
          // is exactly what made the thumb run away on its own.
          const deltaTime = newVisS - this._sbDragStartVisS;
          this.playhead = clamp(this._sbDragStartPlayhead + deltaTime, 0, this.duration);
        }
        this._relockScroll();
      } else {
        // newVisS/newVisE were clamped in time-space, but re-clamping pps against its
        // own [minPps, 1200] bounds just above can shift the time->pixel ratio slightly
        // out from under that clamp — so scrollX still needs its own authoritative
        // ceiling, not just the existing floor of 0, to fully stop the small residual
        // overshoot.
        const maxScroll = Math.max(0, this.duration * this.pps - visibleW);
        this.scrollX = clamp(newVisS * this.pps, 0, maxScroll);
      }
      this.wavCache = null;
      this._redraw();
      return;
    }

    if (this._panning) {
      const dx = pt.x - this._panLastX;
      this._panLastX = pt.x;
      if (this.orientation === "vertical") {
        this.playhead = clamp(this.playhead - dx / this.pps, 0, this.duration);
        this._relockScroll();
      } else {
        const maxScroll = Math.max(0, this.duration * this.pps - (this._canvasCssW - HEADER_WIDTH));
        this.scrollX = clamp(this.scrollX - dx, 0, maxScroll);
      }
      this._redraw();
      return;
    }

    if (this._seeking) {
      if (this.orientation === "vertical") {
        // Absolute _xToTime(pt.x) would fight with _relockScroll() here — scrollX is
        // derived from playhead every frame in this mode, so re-deriving playhead from
        // a pt.x measured against that same (just-changed) scrollX is circular and
        // drifts. Tracking the cursor's own frame-to-frame delta instead — the same
        // pattern panning already uses — sidesteps that entirely.
        const dx = pt.x - this._seekLastX;
        this._seekLastX = pt.x;
        this.playhead = clamp(this.playhead + dx / this.pps, 0, this.duration);
        this._relockScroll();
      } else {
        this.playhead = clamp(this._xToTime(pt.x), 0, this.duration);
      }
      this._redraw();
      return;
    }

    if (this._dragSky) {
      const mouseTime = this._xToTime(pt.x);
      if (this._dragSkyMode === 1) {
        const dur = this._dragSky.endTime - this._dragSky.startTime;
        const newStart = Math.max(0, mouseTime - this._dragSkyOffset);
        this._dragSky.startTime = newStart;
        this._dragSky.endTime = newStart + dur;
      } else if (this._dragSkyMode === 2) {
        this._dragSky.startTime = clamp(mouseTime, 0, this._dragSky.endTime - MIN_SKY_DUR);
      } else if (this._dragSkyMode === 3) {
        this._dragSky.endTime = Math.max(mouseTime, this._dragSky.startTime + MIN_SKY_DUR);
      }
      this._redraw();
      return;
    }

    if (this._dragTp) {
      const mouseTime = this._xToTime(pt.x);
      this._dragTp.startTime = Math.max(0, mouseTime - this._dragTpOffset);
      this.timingPoints.sort((a, b) => a.startTime - b.startTime);
      this._redraw();
      return;
    }

    if (this._dragNote) {
      const mouseTime = this._xToTime(pt.x);
      const trackIdx = clamp(this._yToTrackIdx(pt.y), 0, TRACKS.length - 1);
      if (e.shiftKey && !this._dragResizing && this._dragNote.track !== HEAVY_TRACK) {
        this._dragResizing = true;
        this._dragOffset = mouseTime - this._dragNote.endTime;
      }
      if (this._dragResizing) {
        if (this._dragNote.track !== HEAVY_TRACK) {
          const newEnd = this._snapped(mouseTime - this._dragOffset);
          this._dragNote.endTime = Math.max(this._dragNote.startTime + MIN_HOLD_DUR, newEnd);
        }
      } else if (this.selectedNotes.size > 1) {
        const oldIdx = this._trackIdxOf(this._dragNote.track);
        const tDelta = trackIdx - oldIdx;
        const delta = this._snapped(Math.max(0, mouseTime - this._dragOffset)) - this._dragNote.startTime;
        for (const n of this.selectedNotes) {
          if (e.ctrlKey) {
            const ni = clamp(this._trackIdxOf(n.track) + tDelta, 0, TRACKS.length - 1);
            n.track = TRACKS[ni];
            if (n.track === HEAVY_TRACK) { n.endTime = n.startTime; n.category = HEAVY_CATEGORY; }
          } else {
            const dur = n.endTime - n.startTime;
            n.startTime = Math.max(0, n.startTime + delta);
            n.endTime = n.startTime + dur;
          }
        }
      } else {
        if (e.ctrlKey) {
          this._dragNote.track = TRACKS[trackIdx];
          if (this._dragNote.track === HEAVY_TRACK) {
            this._dragNote.endTime = this._dragNote.startTime;
            this._dragNote.category = HEAVY_CATEGORY;
          }
        } else {
          const newStart = this._snapped(Math.max(0, mouseTime - this._dragOffset));
          const dur = this._dragNote.endTime - this._dragNote.startTime;
          this._dragNote.startTime = newStart;
          this._dragNote.endTime = newStart + dur;
        }
      }
      this._redraw();
      return;
    }

    if (this._boxSelecting) {
      this._boxCurrent = pt;
      this._redraw();
    }
  }

  _onPointerUp(e) {
    if (this._sbDrag) { this._sbDrag = 0; this.el.canvas.releasePointerCapture(e.pointerId); return; }
    if (this._panning) { this._panning = false; this.el.canvas.releasePointerCapture(e.pointerId); return; }
    if (this._seeking) { this._seeking = false; this.el.canvas.releasePointerCapture(e.pointerId); return; }
    if (this._dragSky) {
      this.skyPoints.sort((a, b) => a.startTime - b.startTime);
      this._dragSky = null;
      this.el.canvas.releasePointerCapture(e.pointerId);
      return;
    }
    if (this._dragTp) { this._dragTp = null; this.el.canvas.releasePointerCapture(e.pointerId); return; }

    if (this._boxSelecting) {
      const tMin = this._xToTime(Math.min(this._boxStart.x, this._boxCurrent.x));
      const tMax = this._xToTime(Math.max(this._boxStart.x, this._boxCurrent.x));
      const yMin = Math.min(this._boxStart.y, this._boxCurrent.y);
      const yMax = Math.max(this._boxStart.y, this._boxCurrent.y);
      for (const n of this.notes) {
        const ni = this._trackIdxOf(n.track);
        if (ni < 0) continue;
        const ny = this._timelineRect.y + this._trackY(ni);
        const ny2 = ny + this._trackHeights[ni];
        const timeOverlap = n.startTime <= tMax && n.endTime >= tMin;
        const yOverlap = ny < yMax && ny2 > yMin;
        if (timeOverlap && yOverlap) this.selectedNotes.add(n);
      }
      this._boxSelecting = false;
      this._redraw();
    }
    if (this._dragNote) { this._dragNote = null; this.el.canvas.releasePointerCapture(e.pointerId); }
  }

  // ── Keyboard ──────────────────────────────────────────────────────────
  _onKeyDown(e) {
    if (!this.active) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    if (e.code === "Space") { this.togglePlay(); e.preventDefault(); return; }

    if (e.key.toLowerCase() === "f" && this.playing) {
      const t = this._snapped(this.playhead);
      this.notes.push({ track: REC_TRACK, startTime: t, endTime: t, category: REC_CATEGORY });
      this.notes.sort((a, b) => a.startTime - b.startTime);
      e.preventDefault();
      return;
    }

    if ((e.key === "Delete" || e.key === "Backspace") && this.selectedNotes.size > 0) {
      this.notes = this.notes.filter((n) => !this.selectedNotes.has(n));
      this.selectedNotes.clear();
      this._redraw();
      e.preventDefault();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selectedSky) {
      this.skyPoints = this.skyPoints.filter((s) => s !== this.selectedSky);
      this.selectedSky = null;
      this.el.sky.value = "-1";
      this._redraw();
      e.preventDefault();
      return;
    }

    if (e.key.toLowerCase() === "d" && this.selectedNotes.size > 0) {
      const anyNotDrum = [...this.selectedNotes].some((n) => n.category !== "Drums");
      for (const n of this.selectedNotes) n.category = anyNotDrum ? "Drums" : "Other";
      this._redraw();
      e.preventDefault();
      return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === "s") { this.save(); e.preventDefault(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "z") { this._swapUndo(); this._redraw(); e.preventDefault(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "a") {
      for (const n of this.notes) this.selectedNotes.add(n);
      this._redraw();
      e.preventDefault();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "c") {
      if (this.selectedNotes.size > 0) {
        this.clipboard = [];
        const refTime = Math.min(...[...this.selectedNotes].map((n) => n.startTime));
        for (const n of this.selectedNotes) this.clipboard.push({ track: n.track, rStart: n.startTime - refTime, rEnd: n.endTime - refTime, cat: n.category });
        this.copyRefTime = refTime;
      }
      e.preventDefault();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "v") {
      this._pasteClipboard();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      this.selectedNotes.clear();
      this.clipboard = [];
      this._redraw();
      e.preventDefault();
      return;
    }
  }

  _pasteClipboard() {
    if (this.clipboard.length === 0) return;
    this._saveUndo();
    const created = [];
    for (const { track: srcTrack, rStart, rEnd, cat } of this.clipboard) {
      const s = this.copyRefTime + rStart;
      const end = this.copyRefTime + rEnd;
      const idx = this._trackIdxOf(srcTrack);
      let target = -1;
      for (const candidate of [idx + 1, idx - 1]) {
        if (candidate < 0 || candidate >= TRACKS.length) continue;
        const tName = TRACKS[candidate];
        const overlap = this.notes.some((n) => n.track === tName && n.startTime < end && n.endTime > s);
        if (!overlap) { target = candidate; break; }
      }
      if (target < 0) continue;
      const destTrack = TRACKS[target];
      let destEnd = end, destCat = cat;
      if (destTrack === HEAVY_TRACK) { destEnd = s; destCat = HEAVY_CATEGORY; }
      const copy = { track: destTrack, startTime: s, endTime: destEnd, category: destCat };
      this.notes.push(copy);
      created.push(copy);
    }
    if (created.length > 0) {
      this.notes.sort((a, b) => a.startTime - b.startTime);
      this.selectedNotes.clear();
      for (const n of created) this.selectedNotes.add(n);
    }
    this._redraw();
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

let _beepCtx = null;
function beep(freq, dur) {
  try {
    _beepCtx = _beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = _beepCtx.createOscillator();
    const gain = _beepCtx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, _beepCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, _beepCtx.currentTime + dur);
    osc.connect(gain).connect(_beepCtx.destination);
    osc.start();
    osc.stop(_beepCtx.currentTime + dur);
  } catch {
    /* audio context unavailable — ignore */
  }
}
