import { bridge, toast } from "./bridge.js";
import { difficultyLabel } from "./difficulty.js";
import { ICONS } from "./icons.js";

const EMPTY_CSV_HEADER = "NoteTrackName,NoteTime,IsRelease,NoteCategory\n";
const DEFAULT_NORMAL_RATE = 5;
const DEFAULT_HARD_RATE = 8;
const MAX_STARS = 12;
const TRACK_COUNT_OPTIONS = [2, 4, 6, 8];

export const library = {
  songs: [],
  async refresh() {
    this.songs = await bridge.call("scanSongs");
    return this.songs;
  },
  find(folder) {
    return this.songs.find((s) => s.folder === folder) || null;
  },
};

export function renderSongList(container, { selectedFolder, filterText, onSelect }) {
  container.innerHTML = "";
  const needle = (filterText || "").trim().toLowerCase();
  const list = library.songs.filter((s) => {
    if (!needle) return true;
    return (s.title || "").toLowerCase().includes(needle) || (s.subtitle || "").toLowerCase().includes(needle);
  });

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:var(--text-2);font-size:12px;padding:14px 6px;";
    empty.textContent = library.songs.length === 0 ? "还没有歌曲，点击右上角「+ 新建」" : "没有匹配的歌曲";
    container.appendChild(empty);
    return;
  }

  for (const song of list) {
    const card = document.createElement("div");
    card.className = "song-card" + (song.folder === selectedFolder ? " active" : "");
    card.dataset.folder = song.folder;

    const cover = document.createElement("div");
    cover.className = "cover";
    if (song.coverUrl) cover.style.backgroundImage = `url("${song.coverUrl}")`;

    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = song.title || "(未命名)";
    const subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    subtitle.textContent = song.subtitle || song.folder;
    info.append(title, subtitle);

    const dot = document.createElement("div");
    dot.className = "dot" + (song.isComplete ? "" : " incomplete");
    dot.title = song.isComplete ? "配置完整" : "缺少: " + song.missing.join(", ");

    card.append(cover, info, dot);
    card.addEventListener("click", () => onSelect(song.folder));
    container.appendChild(card);
  }
}

export function renderConfigForm(container, song, { onChanged }) {
  container.innerHTML = "";
  const form = document.createElement("div");
  form.className = "config-form";

  // ── Media column ──────────────────────────────────────
  const mediaCol = document.createElement("div");
  mediaCol.className = "config-media";

  const cover = document.createElement("div");
  cover.className = "cover-preview";
  if (song.coverUrl) cover.style.backgroundImage = `url("${song.coverUrl}")`;
  const coverBtn = button(song.coverUrl ? "更换封面…" : "导入封面…", async () => {
    const path = await bridge.call("pickImageFile");
    if (!path) return;
    const subtitle = subtitleInput.input.value.trim() || song.folder;
    try {
      await bridge.call("importCover", { folder: song.folder, sourcePath: path, subtitle });
      toast("封面已更新");
      onChanged();
    } catch (err) {
      toast(String(err.message || err), true);
    }
  }, "image");

  const audioBtn = button(song.audioUrl ? "更换音频…" : "导入音频…", async () => {
    const path = await bridge.call("pickAudioFile");
    if (!path) return;
    const title = titleInput.input.value.trim() || "Untitled";
    const trackCount = trackCountInput.value;
    try {
      await bridge.call("importAudio", { folder: song.folder, sourcePath: path, title, trackCount });
      toast("音频已更新");
      onChanged();
    } catch (err) {
      toast(String(err.message || err), true);
    }
  }, "music");

  mediaCol.append(cover, coverBtn, audioBtn);

  // ── Fields column ─────────────────────────────────────
  const fields = document.createElement("div");
  fields.className = "field-group";

  const titleInput = textField("标题", song.title || "", async (val) => {
    if (!song.audioUrl) return; // no audio yet, nothing to rename — importAudio will pick this up
    try {
      await bridge.call("renameSong", { folder: song.folder, title: val.trim() || "Untitled" });
      toast("标题已更新");
      onChanged();
    } catch (err) {
      toast(String(err.message || err), true);
    }
  }, "tag");

  const subtitleInput = textField("副标题", song.subtitle || "", async (val) => {
    if (!song.coverUrl) return;
    try {
      await bridge.call("setSubtitle", { folder: song.folder, subtitle: val.trim() || song.folder });
      toast("副标题已更新");
      onChanged();
    } catch (err) {
      toast(String(err.message || err), true);
    }
  }, "alignLeft");

  const trackCountInput = choiceField("音轨数", TRACK_COUNT_OPTIONS, song.trackCount || 4, async (val) => {
    if (!song.audioUrl) return;
    try {
      await bridge.call("setTrackCount", { folder: song.folder, trackCount: val });
      toast("音轨数已更新");
      onChanged();
    } catch (err) {
      toast(String(err.message || err), true);
    }
  }, "sliders");

  const normalRate = starField(difficultyLabel("Normal") + "星级", song.normalRate || 0, (val) =>
    setRate(song, "Normal", val, onChanged), "flag"
  );
  const hardRate = starField(difficultyLabel("Hard") + "星级", song.hardRate || 0, (val) =>
    setRate(song, "Hard", val, onChanged), "flag"
  );

  fields.append(titleInput.field, subtitleInput.field, trackCountInput.field, normalRate.field, hardRate.field);

  form.append(mediaCol, fields);
  container.appendChild(form);
}

// Modal shown for "+ 新建": collects every required field up front and only
// creates the song folder once the user confirms, so no incomplete entries
// can exist in the library — the create button validates instead.
export function openCreateSongModal({ onCreated }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = "modal-dialog";

  const heading = document.createElement("h2");
  heading.textContent = "新建歌曲";
  dialog.appendChild(heading);

  const body = document.createElement("div");
  body.className = "modal-body";

  const titleF = textField("标题", "", undefined, "tag");
  const subtitleF = textField("副标题", "", undefined, "alignLeft");
  const trackCountF = choiceField("音轨数", TRACK_COUNT_OPTIONS, 4, undefined, "sliders");
  const normalRateF = starField(difficultyLabel("Normal") + "星级", DEFAULT_NORMAL_RATE, undefined, "flag");
  const hardRateF = starField(difficultyLabel("Hard") + "星级", DEFAULT_HARD_RATE, undefined, "flag");

  let audioPath = null;
  let coverPath = null;

  const audioRow = filePickRow("音频文件");
  const audioPickBtn = button("选择音频…", async () => {
    const p = await bridge.call("pickAudioFile");
    if (!p) return;
    audioPath = p;
    audioRow.setStatus(p.split(/[\\/]/).pop());
  }, "music");
  const audioField = document.createElement("div");
  audioField.className = "field";
  audioField.append(audioRow.row, audioPickBtn);

  const coverRow = filePickRow("封面图片");
  const coverPickBtn = button("选择封面…", async () => {
    const p = await bridge.call("pickImageFile");
    if (!p) return;
    coverPath = p;
    coverRow.setStatus(p.split(/[\\/]/).pop());
  }, "image");
  const coverField = document.createElement("div");
  coverField.className = "field";
  coverField.append(coverRow.row, coverPickBtn);

  body.append(titleF.field, subtitleF.field, trackCountF.field, audioField, coverField, normalRateF.field, hardRateF.field);
  dialog.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancelBtn = button("取消", () => close(), "x");
  const createBtn = document.createElement("button");
  createBtn.className = "btn btn-primary";
  createBtn.innerHTML = ICONS.check(14);
  createBtn.append(document.createTextNode("创建"));
  createBtn.addEventListener("click", handleCreate);
  actions.append(cancelBtn, createBtn);
  dialog.appendChild(actions);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  titleF.input.focus();

  function close() {
    overlay.remove();
  }

  async function handleCreate() {
    const title = titleF.input.value.trim();
    const subtitle = subtitleF.input.value.trim();
    const trackCount = trackCountF.value;
    const normalRate = normalRateF.value;
    const hardRate = hardRateF.value;

    const missing = [];
    if (!title) missing.push("标题");
    if (!subtitle) missing.push("副标题");
    if (!audioPath) missing.push("音频文件");
    if (!coverPath) missing.push("封面图片");
    if (trackCount <= 0) missing.push("音轨数");
    if (normalRate <= 0) missing.push(difficultyLabel("Normal") + "星级");
    if (hardRate <= 0) missing.push(difficultyLabel("Hard") + "星级");
    if (missing.length > 0) {
      toast("请先填写完整信息：" + missing.join("、"), true);
      return;
    }

    createBtn.disabled = true;
    cancelBtn.disabled = true;
    let folder = null;
    try {
      folder = await bridge.call("createSong");
      await bridge.call("importAudio", { folder, sourcePath: audioPath, title, trackCount });
      await bridge.call("importCover", { folder, sourcePath: coverPath, subtitle });
      await bridge.call("saveChart", { folder, difficulty: "Normal", rate: normalRate, csv: EMPTY_CSV_HEADER });
      await bridge.call("saveChart", { folder, difficulty: "Hard", rate: hardRate, csv: EMPTY_CSV_HEADER });
      close();
      onCreated(folder);
    } catch (err) {
      if (folder) {
        try { await bridge.call("deleteSong", { folder }); } catch { /* best-effort cleanup */ }
      }
      toast("创建失败：" + (err.message || err), true);
      createBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  }
}

async function setRate(song, difficulty, rate, onChanged) {
  try {
    const existing = await bridge.call("loadChart", { folder: song.folder, difficulty });
    const csv = existing.exists ? existing.csv : EMPTY_CSV_HEADER;
    await bridge.call("saveChart", { folder: song.folder, difficulty, rate, csv });
    toast(`${difficultyLabel(difficulty)}星级已更新`);
    onChanged();
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

function button(label, onClick, iconKey = null) {
  const btn = document.createElement("button");
  btn.className = "btn";
  if (iconKey) btn.innerHTML = ICONS[iconKey](14);
  btn.append(document.createTextNode(label));
  btn.addEventListener("click", onClick);
  return btn;
}

function buildLabel(text, iconKey) {
  const l = document.createElement("label");
  if (iconKey) l.innerHTML = ICONS[iconKey](12);
  l.append(document.createTextNode(text));
  return l;
}

// A single-line "[icon] 音频文件 | 未选择" row used above the pick buttons in the
// create-song modal — label and current-selection status share one row instead of
// stacking across two.
function filePickRow(labelText) {
  const row = document.createElement("div");
  row.className = "pick-row";
  const labelSpan = document.createElement("span");
  labelSpan.className = "pick-label";
  labelSpan.innerHTML = ICONS.file(12);
  labelSpan.append(document.createTextNode(labelText));
  const sep = document.createElement("span");
  sep.className = "pick-sep";
  sep.textContent = "|";
  const status = document.createElement("span");
  status.className = "pick-status";
  status.textContent = "未选择";
  row.append(labelSpan, sep, status);
  return {
    row,
    setStatus(text) {
      status.textContent = text;
      status.classList.add("picked");
    },
  };
}

function textField(label, value, onCommit = () => {}, iconKey = null) {
  const field = document.createElement("div");
  field.className = "field";
  const l = buildLabel(label, iconKey);
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.addEventListener("change", () => onCommit(input.value));
  field.append(l, input);
  return { field, input };
}

function starField(label, value, onCommit = () => {}, iconKey = null) {
  const field = document.createElement("div");
  field.className = "field";
  const l = buildLabel(label, iconKey);
  const wrap = document.createElement("div");
  wrap.className = "star-picker";

  let current = Math.max(0, Math.min(MAX_STARS, value | 0));
  const starEls = [];

  function paint(upTo) {
    starEls.forEach((s, idx) => s.classList.toggle("filled", idx < upTo));
  }

  for (let i = 1; i <= MAX_STARS; i++) {
    const s = document.createElement("span");
    s.className = "star";
    s.textContent = "★";
    s.addEventListener("mouseenter", () => paint(i));
    s.addEventListener("click", () => {
      current = i;
      paint(current);
      onCommit(current);
    });
    starEls.push(s);
    wrap.appendChild(s);
  }
  wrap.addEventListener("mouseleave", () => paint(current));
  paint(current);

  field.append(l, wrap);
  return {
    field,
    get value() { return current; },
    set value(v) { current = Math.max(0, Math.min(MAX_STARS, v | 0)); paint(current); },
  };
}

function choiceField(label, options, value, onCommit = () => {}, iconKey = null) {
  const field = document.createElement("div");
  field.className = "field";
  const l = buildLabel(label, iconKey);
  const wrap = document.createElement("div");
  wrap.className = "choice-picker";

  let current = options.includes(value) ? value : options[0];
  const btnEls = [];

  function paint() {
    btnEls.forEach((b) => b.classList.toggle("selected", b.dataset.val === String(current)));
  }

  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "choice-btn";
    b.dataset.val = String(opt);
    b.textContent = String(opt);
    b.addEventListener("click", () => {
      current = opt;
      paint();
      onCommit(current);
    });
    btnEls.push(b);
    wrap.appendChild(b);
  }
  paint();

  field.append(l, wrap);
  return {
    field,
    get value() { return current; },
    set value(v) { current = options.includes(v) ? v : options[0]; paint(); },
  };
}
