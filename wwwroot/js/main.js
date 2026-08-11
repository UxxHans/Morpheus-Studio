import { bridge, toast, confirmDialog } from "./bridge.js";
import { library, renderSongList, renderConfigForm, openCreateSongModal } from "./songLibrary.js";
import { ChartEditor } from "./chartEditor.js";

const els = {
  songList: document.getElementById("songList"),
  searchBox: document.getElementById("searchBox"),
  newSongBtn: document.getElementById("newSongBtn"),
  emptyState: document.getElementById("emptyState"),
  songDetail: document.getElementById("songDetail"),
  detailTitle: document.getElementById("detailTitle"),
  completenessBadge: document.getElementById("completenessBadge"),
  tabs: document.getElementById("tabs"),
  revealBtn: document.getElementById("revealBtn"),
  deleteSongBtn: document.getElementById("deleteSongBtn"),
  tabConfig: document.getElementById("tab-config"),
};

let selectedFolder = null;
let activeTab = "config";

const chartEditors = {
  Normal: new ChartEditor(document.getElementById("tab-chart-Normal"), "Normal"),
  Hard: new ChartEditor(document.getElementById("tab-chart-Hard"), "Hard"),
};

async function refreshList(keepSelection = true) {
  await library.refresh();
  if (keepSelection && selectedFolder && !library.find(selectedFolder)) selectedFolder = null;
  renderSongList(els.songList, {
    selectedFolder,
    filterText: els.searchBox.value,
    onSelect: selectSong,
  });
}

function selectSong(folder) {
  selectedFolder = folder;
  renderSongList(els.songList, { selectedFolder, filterText: els.searchBox.value, onSelect: selectSong });
  showDetail();
}

function showDetail() {
  const song = library.find(selectedFolder);
  if (!song) {
    els.emptyState.classList.remove("hidden");
    els.songDetail.classList.add("hidden");
    return;
  }
  els.emptyState.classList.add("hidden");
  els.songDetail.classList.remove("hidden");
  els.detailTitle.textContent = song.title || "(未命名)";
  els.completenessBadge.textContent = song.isComplete ? "完整" : `缺 ${song.missing.length} 项`;
  els.completenessBadge.className = "badge " + (song.isComplete ? "ok" : "warn");

  renderConfigForm(els.tabConfig, song, { onChanged: onSongChanged });
  chartEditors.Normal.loadSong(song);
  chartEditors.Hard.loadSong(song);
  setActiveTab(activeTab);
}

async function onSongChanged() {
  const folder = selectedFolder;
  await refreshList();
  selectedFolder = folder;
  showDetail();
}

function setActiveTab(tab) {
  activeTab = tab;
  for (const btn of els.tabs.querySelectorAll(".tab-btn")) btn.classList.toggle("active", btn.dataset.tab === tab);
  for (const panel of document.querySelectorAll(".tab-panel")) panel.classList.toggle("active", panel.id === "tab-" + tab);
  chartEditors.Normal.setActive(tab === "chart-Normal");
  chartEditors.Hard.setActive(tab === "chart-Hard");
}

els.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (btn) setActiveTab(btn.dataset.tab);
});

els.searchBox.addEventListener("input", () => {
  renderSongList(els.songList, { selectedFolder, filterText: els.searchBox.value, onSelect: selectSong });
});

els.newSongBtn.addEventListener("click", () => {
  openCreateSongModal({
    onCreated: async (folder) => {
      await refreshList();
      selectSong(folder);
      toast("已创建歌曲");
    },
  });
});

els.deleteSongBtn.addEventListener("click", async () => {
  const song = library.find(selectedFolder);
  if (!song) return;
  const ok = await confirmDialog(`确定删除「${song.title || song.folder}」？此操作不可撤销。`, {
    title: "删除歌曲",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await bridge.call("deleteSong", { folder: song.folder });
    selectedFolder = null;
    await refreshList();
    showDetail();
    toast("已删除");
  } catch (err) {
    toast(String(err.message || err), true);
  }
});

els.revealBtn.addEventListener("click", () => {
  if (selectedFolder) bridge.call("revealFolder", { folder: selectedFolder });
});

refreshList().then(showDetail);
