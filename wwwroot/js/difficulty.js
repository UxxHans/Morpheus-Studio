// Display labels only — the underlying keys ("Normal" / "Hard") must stay as-is,
// they're what gets written into "Normal[n].csv" / "Hard[n].csv" filenames that
// MusicCollectionSelection.cs parses on the Unity side.
export const DIFFICULTY_LABELS = { Normal: "普通难度", Hard: "困难难度" };

export function difficultyLabel(key) {
  return DIFFICULTY_LABELS[key] || key;
}
