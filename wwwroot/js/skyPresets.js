// Verbatim port of BeatEditorWindow.cs SKY_PRESETS (Downloads/BeatEditorWindow.cs:70-160).
export const SKY_PRESETS = [
  { name: "蓝天", timeOfDay: 12, cloudScale: 5, cloudDensity: 0.35, cloudHeight: 0.3 },
  { name: "深夜", timeOfDay: 0, cloudScale: 5, cloudDensity: 0.35, cloudHeight: 0.3 },
  { name: "科技", timeOfDay: 6.5, cloudScale: 5, cloudDensity: 0.35, cloudHeight: 0.3 },
  { name: "赛博", timeOfDay: 7, cloudScale: 5, cloudDensity: 0.35, cloudHeight: 0.3 },
  { name: "蛋糕", timeOfDay: 7.5, cloudScale: 5, cloudDensity: 0.35, cloudHeight: 0.3 },
  { name: "艳紫", timeOfDay: 8, cloudScale: 5, cloudDensity: 0.35, cloudHeight: 0.3 },
  { name: "蓝紫", timeOfDay: 16, cloudScale: 5, cloudDensity: 0.35, cloudHeight: 0.3 },
  { name: "红酒", timeOfDay: 16.5, cloudScale: 5, cloudDensity: 0.35, cloudHeight: 0.3 },
  { name: "热情", timeOfDay: 17, cloudScale: 5, cloudDensity: 0.35, cloudHeight: 0.3 },
  { name: "岩浆", timeOfDay: 17.5, cloudScale: 5, cloudDensity: 0.35, cloudHeight: 0.3 },
  { name: "果冻", timeOfDay: 18, cloudScale: 5, cloudDensity: 0.35, cloudHeight: 0.3 },
];

const EPS = 0.01;

export function findSkyPresetIndex(sky) {
  for (let i = 0; i < SKY_PRESETS.length; i++) {
    const p = SKY_PRESETS[i];
    if (
      Math.abs(sky.timeOfDay - p.timeOfDay) < EPS &&
      Math.abs(sky.cloudScale - p.cloudScale) < EPS &&
      Math.abs(sky.cloudDensity - p.cloudDensity) < EPS &&
      Math.abs(sky.cloudHeight - p.cloudHeight) < EPS
    )
      return i;
  }
  return -1;
}
