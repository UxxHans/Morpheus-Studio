using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.Json;

namespace BeatMapStudio.Services;

public class NoteDto
{
    public string Track { get; set; } = "";
    public double StartTime { get; set; }
    public double EndTime { get; set; }
    public string Category { get; set; } = "Other";
}

public class TimingPointDto
{
    public double StartTime { get; set; }
    public double Bpm { get; set; }
    public double Offset { get; set; }
}

public class MczImportResult
{
    public List<NoteDto> Notes { get; set; } = new();
    public List<TimingPointDto> TimingPoints { get; set; } = new();
    public List<string> Warnings { get; set; } = new();
    public int SourceColumns { get; set; }
}

/// <summary>
/// Converts a Malody chart package (.mcz — a zip containing one or more .mc JSON charts)
/// into our note/timing-point model. Verified against a real .mc file: the "beat"
/// triples are [wholeBeats, numerator, denominator] measured directly in beats (not
/// measures) — cross-checked beatValue*60/bpm against the actual decoded audio duration.
/// </summary>
public static class MczImportService
{
    // The nested pairing chartEditor.js uses for the lettered lanes: D/E innermost (2),
    // then C/F (4), then B/G (6), then A/H outermost (8). Must stay in sync with
    // TRACK_TIERS in wwwroot/js/chartEditor.js.
    private static readonly Dictionary<int, string[]> CenteredTracks = new()
    {
        [2] = new[] { "D", "E" },
        [4] = new[] { "C", "D", "E", "F" },
        [6] = new[] { "B", "C", "D", "E", "F", "G" },
        [8] = new[] { "A", "B", "C", "D", "E", "F", "G", "H" },
    };

    public static MczImportResult Import(string mczPath, int mode)
    {
        var warnings = new List<string>();
        JsonDocument? doc = null;
        int qualifying = 0;

        try
        {
            using var archive = ZipFile.OpenRead(mczPath);
            var mcEntries = archive.Entries
                .Where(e => e.FullName.EndsWith(".mc", StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (mcEntries.Count == 0)
                throw new InvalidOperationException("mcz 文件里没有找到谱面数据（.mc）");

            foreach (var entry in mcEntries)
            {
                using var stream = entry.Open();
                using var reader = new StreamReader(stream, Encoding.UTF8);
                string text = reader.ReadToEnd();

                JsonDocument candidate;
                try { candidate = JsonDocument.Parse(text); }
                catch { continue; }

                bool isKeyMode = candidate.RootElement.TryGetProperty("meta", out var metaEl)
                    && metaEl.TryGetProperty("mode_ext", out var modeExtEl)
                    && modeExtEl.TryGetProperty("column", out _);

                if (isKeyMode)
                {
                    qualifying++;
                    if (doc == null) doc = candidate;
                    else candidate.Dispose();
                }
                else
                {
                    candidate.Dispose();
                }
            }
        }
        catch (InvalidDataException)
        {
            throw new InvalidOperationException("无法解析 mcz 文件：不是有效的压缩包");
        }

        if (doc == null)
            throw new InvalidOperationException("mcz 里没有找到按键模式（key mode）的谱面数据");
        if (qualifying > 1)
            warnings.Add($"mcz 内含 {qualifying} 个谱面，已使用第一个");

        using (doc)
        {
            var root = doc.RootElement;
            var meta = root.GetProperty("meta");
            int columns = meta.GetProperty("mode_ext").GetProperty("column").GetInt32();

            // The note[] array carries one non-playable entry (truthy "type", no "column")
            // that marks the audio trigger — its "offset" (milliseconds) is the chart's
            // global lead-in: beat 0 actually lands at -offset, not at t=0. Every other
            // timestamp is anchored off of this, so it has to seed the accumulator below
            // rather than being treated as just another field to ignore. Confirmed against
            // a known-good Malody→osu converter, which seeds its own accumulator with
            // exactly -offset.
            double initialOffsetSeconds = 0;
            if (root.TryGetProperty("note", out var offsetScanArr))
            {
                foreach (var n in offsetScanArr.EnumerateArray())
                {
                    if (n.TryGetProperty("type", out var typeEl) && typeEl.GetDouble() != 0
                        && n.TryGetProperty("offset", out var offsetEl))
                    {
                        initialOffsetSeconds = -offsetEl.GetDouble() / 1000.0;
                    }
                }
            }

            // ── Timing points ────────────────────────────────────────────────
            var segments = new List<(double beat, double bpm)>();
            if (root.TryGetProperty("time", out var timeArr))
            {
                foreach (var t in timeArr.EnumerateArray())
                {
                    double beat = BeatValue(t.GetProperty("beat"));
                    double bpm = t.GetProperty("bpm").GetDouble();
                    if (bpm > 0) segments.Add((beat, bpm));
                }
            }
            segments.Sort((a, b) => a.beat.CompareTo(b.beat));
            if (segments.Count == 0)
                throw new InvalidOperationException("谱面缺少 BPM 时间点数据，无法换算时间");

            double BeatToSeconds(double beat)
            {
                double acc = initialOffsetSeconds;
                for (int i = 0; i < segments.Count; i++)
                {
                    double segStart = segments[i].beat;
                    double segEnd = i + 1 < segments.Count ? segments[i + 1].beat : double.PositiveInfinity;
                    if (beat <= segStart) return acc;
                    double effectiveEnd = Math.Min(beat, segEnd);
                    double elapsed = effectiveEnd - segStart;
                    if (elapsed > 0) acc += elapsed * 60.0 / segments[i].bpm;
                    if (beat <= segEnd) break;
                }
                return acc;
            }

            // The editor's beat-grid and note-snap both anchor their phase on Offset (Bias),
            // independent of StartTime — always importing Offset=0 leaves the grid phased
            // from t=0 while notes actually land at StartTime + k*(60/bpm), so whenever
            // StartTime isn't itself an exact multiple of the grid unit (e.g. once the
            // lead-in above shifts it off zero), the grid and the imported notes drift out
            // of phase by a small constant amount — reads as "every note is off by a hair".
            // Snap/grid math is periodic in the grid unit, so reducing StartTime modulo it
            // reproduces the exact same phase while keeping the value small (fits the ±0.5s
            // Bias slider regardless of BPM, instead of the raw StartTime which could exceed
            // it for charts with a longer lead-in).
            var timingPoints = segments
                .Select(s =>
                {
                    double startTime = BeatToSeconds(s.beat);
                    double gridUnit = s.bpm > 0 ? 60.0 / s.bpm / 8.0 : 0;
                    double offset = gridUnit > 0 ? ((startTime % gridUnit) + gridUnit) % gridUnit : 0;
                    return new TimingPointDto { StartTime = startTime, Bpm = s.bpm, Offset = offset };
                })
                .ToList();

            // ── Notes ────────────────────────────────────────────────────────
            var rawNotes = new List<(double start, double end, int column)>();
            if (root.TryGetProperty("note", out var noteArr))
            {
                foreach (var n in noteArr.EnumerateArray())
                {
                    // Rows without "column" are sample/sound-effect markers, not playable notes.
                    if (!n.TryGetProperty("column", out var colEl)) continue;
                    int column = colEl.GetInt32();
                    double start = BeatToSeconds(BeatValue(n.GetProperty("beat")));
                    double end = start;
                    if (n.TryGetProperty("endbeat", out var endBeatEl))
                    {
                        double endVal = BeatToSeconds(BeatValue(endBeatEl));
                        if (endVal > start) end = endVal;
                    }
                    rawNotes.Add((start, end, column));
                }
            }

            var mapping = BuildColumnMapping(columns, mode, warnings);
            var notes = new List<NoteDto>();
            foreach (var (start, end, column) in rawNotes)
            {
                if (!mapping.TryGetValue(column, out var mapped)) continue; // dropped column
                notes.Add(new NoteDto { Track = mapped.track, StartTime = start, EndTime = end, Category = mapped.category });
            }

            if (Math.Abs(initialOffsetSeconds) > 0.0001)
                warnings.Add($"已应用 mcz 自带的整体偏移 {initialOffsetSeconds:F3}s");

            return new MczImportResult
            {
                Notes = notes,
                TimingPoints = timingPoints,
                Warnings = warnings,
                SourceColumns = columns,
            };
        }
    }

    private static double BeatValue(JsonElement beatArr)
    {
        var arr = beatArr.EnumerateArray().Select(e => e.GetInt32()).ToArray();
        if (arr.Length < 3) return arr.Length > 0 ? arr[0] : 0;
        return arr[0] + (arr[2] != 0 ? (double)arr[1] / arr[2] : 0);
    }

    // mode 0 = direct mapping ("whatever tracks exist"); mode 1 = rightmost column is
    // heavy, remaining left columns fall back to the largest of 2/4/6/8 that still fits.
    private static Dictionary<int, (string track, string category)> BuildColumnMapping(
        int columns, int mode, List<string> warnings)
    {
        var result = new Dictionary<int, (string, string)>();

        if (mode == 1)
        {
            int leftCount = columns - 1;
            if (leftCount < 2)
            {
                warnings.Add("左侧轨道数量不足，未按重音轨模式处理，已改为直接映射");
                return BuildColumnMapping(columns, 0, warnings);
            }
            int gameCount = new[] { 8, 6, 4, 2 }.FirstOrDefault(c => c <= leftCount, 2);
            var letters = CenteredTracks[gameCount];
            for (int i = 0; i < letters.Length; i++)
                result[i] = (letters[i], "Other");
            result[columns - 1] = ("HVY", "Heavy");
            if (gameCount < leftCount)
                warnings.Add($"左侧 {leftCount} 条轨道不满足更高档位，回退到 {gameCount} 轨，丢弃了 {leftCount - gameCount} 条超出的轨道");
        }
        else
        {
            int gameCount = new[] { 2, 4, 6, 8 }.FirstOrDefault(c => c >= columns, 8);
            var letters = CenteredTracks[gameCount];
            int usable = Math.Min(columns, letters.Length);
            for (int i = 0; i < usable; i++)
                result[i] = (letters[i], "Other");
            if (columns > letters.Length)
                warnings.Add($"mcz 有 {columns} 条轨道，超出游戏最多 8 条的上限，已丢弃第 9 条及以后的轨道");
        }

        return result;
    }
}
