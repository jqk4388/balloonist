using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

/*
 * BalloonistRaster — speech-bubble geometry for Balloonist (InDesign).
 *
 * Request file (one directive per line, '#' starts a comment):
 *   img=<exported page png>
 *   scale=<px per page point>                        (export dpi / 72)
 *   pad=<0..1, padding kept inside the bubble edge>   default 0.035
 *   thr=<0..255 luminance that counts as paper>       default 200
 *   dil=<ink dilation passes, seals anti-aliased gaps> default 1
 *   h=<0..1 of the local max distance used as h-maxima dome>  default 0.35
 *   dump=<path>.png                                  optional debug overlay
 *   rect=<x1,y1,x2,y2>                               page points, one per frame
 *
 * Result: {"results":[{ok,leak,area,center:[x,y],radius,bbox:[..],
 *                       fitRect:[..],dbg:"...",poly:[[x,y],...]}]}
 *
 * Pipeline
 *   paper mask -> ink dilation (close the outline) -> connected components ->
 *   the blob under the text frame -> fill the old lettering back in ->
 *   chamfer distance -> h-maxima seeds (one per bubble, tails and waists do
 *   not spawn seeds) -> watershed so fused bubbles split -> the bubble that
 *   owns the frame -> its own distance field -> body = 14% of the short side
 *   eroded away, which drops the tail -> body centroid = where the lettering
 *   must sit -> padding-eroded polygon and the largest centred rectangle.
 */

class Program
{
    static int W, H;
    static byte[] mask;
    static byte[] lum;
    static int[] labels;
    static List<Comp> comps = new List<Comp>();

    static string s_dumpPath;
    static bool[] s_lobe;
    static float[] s_d;
    static int s_lw, s_lh, s_x0, s_y0;
    static double s_cx, s_cy, s_padPx, s_r14;
    static double[] s_fit = new double[4];
    static double s_scale = 1;

    class Comp
    {
        public int id, area;
        public int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1;
        public long sumX, sumY;
        public bool touchesBorder;
        public double Cx { get { return (double)sumX / area; } }
        public double Cy { get { return (double)sumY / area; } }
    }

    class Rect
    {
        public double x1, y1, x2, y2;
        public double Cx { get { return (x1 + x2) / 2; } }
        public double Cy { get { return (y1 + y2) / 2; } }
    }

    class Result
    {
        public bool ok, leak;
        public int openRays;   /* radial rays that escaped the ink outline */
    public double fitInk;  /* ink fraction inside the safe rectangle */
        public double[] center = new double[2];
        public double radius;
        public double[] bbox = new double[4];
        public double[] fitRect = new double[4];
        public long area;
        public string dbg = "";
        public List<double[]> poly = new List<double[]>();
    }

    static void Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("usage: BalloonistRaster <request.txt> <result.json>");
            Environment.Exit(2);
        }
        string reqPath = args[0], resPath = args[1];

        string img = null, dump = null, mode = "frames";
        double scale = 2.0, pad = 0.035, hFrac = 0.35;
        double minSide = 30.0, minArea = 1500.0, maxAspect = 6.0, maxAreaFrac = 0.18, minRingInk = 0.30;
        double whiteFrac = 0.985;
        double minRectFill = 0.0;
        int thr = 200, dil = 1, lightThr = 205;
        double minFill = 0.55;
        List<Rect> rects = new List<Rect>();

        foreach (string raw in File.ReadAllLines(reqPath))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line[0] == '#') continue;
            int eq = line.IndexOf('=');
            if (eq <= 0) continue;
            string k = line.Substring(0, eq).Trim().ToLowerInvariant();
            string v = line.Substring(eq + 1).Trim();
            if (k == "img") img = v;
            else if (k == "dump") dump = v;
            else if (k == "thr") thr = (int)double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "dil") dil = (int)double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "h") hFrac = double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "scale") scale = double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "pad") pad = double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "mode") mode = v.ToLowerInvariant();
            else if (k == "minside") minSide = double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "minarea") minArea = double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "maxaspect") maxAspect = double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "maxarea") maxAreaFrac = double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "ring") minRingInk = double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "wfrac") whiteFrac = double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "rfill") minRectFill = double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "lthr") lightThr = (int)double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "fillrate") minFill = double.Parse(v, CultureInfo.InvariantCulture);
            else if (k == "rect")
            {
                string[] p = v.Split(',');
                if (p.Length != 4) continue;
                Rect r = new Rect();
                r.x1 = double.Parse(p[0], CultureInfo.InvariantCulture) * scale;
                r.y1 = double.Parse(p[1], CultureInfo.InvariantCulture) * scale;
                r.x2 = double.Parse(p[2], CultureInfo.InvariantCulture) * scale;
                r.y2 = double.Parse(p[3], CultureInfo.InvariantCulture) * scale;
                rects.Add(r);
            }
        }
        if (img == null || (rects.Count == 0 && mode != "bubbles" && mode != "blobs"))
        {
            Console.Error.WriteLine("bad request: img or rect missing");
            Environment.Exit(3);
        }

        s_scale = scale;
        s_dumpPath = dump;

        using (Bitmap bmp = Load24(img))
        {
            W = bmp.Width; H = bmp.Height;
            mask = new byte[W * H];
            lum = new byte[W * H];
            BitmapData bd = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                int stride = bd.Stride;
                byte[] buf = new byte[stride * H];
                Marshal.Copy(bd.Scan0, buf, 0, buf.Length);
                for (int y = 0; y < H; y++)
                {
                    int row = y * stride;
                    for (int x = 0; x < W; x++)
                    {
                        int i = row + x * 3;
                        int b = buf[i], g = buf[i + 1], r = buf[i + 2];
                        int L = (r * 2 + g * 3 + b) / 6;
                        lum[y * W + x] = (byte)L;
                        mask[y * W + x] = (byte)(L >= thr ? 1 : 0);
                    }
                }
            }
            finally { bmp.UnlockBits(bd); }
        }

        for (int it = 0; it < dil; it++) ErodeWhite();

        LabelComponents();

        StringBuilder json = new StringBuilder();
        if (mode == "blobs")
        {
            List<Result> blobs = Blobs(pad, scale, minSide * scale, minArea * scale * scale,
                                       maxAspect, maxAreaFrac * (long)W * H, minFill, lightThr, dil);
            json.Append("{\"mode\":\"blobs\",\"bubbles\":[");
            for (int i = 0; i < blobs.Count; i++)
            {
                if (i > 0) json.Append(',');
                json.Append(ToJson(blobs[i]));
            }
            json.Append("]}");
            File.WriteAllText(resPath, json.ToString(), new UTF8Encoding(false));
            if (dump != null) WriteBubbleDump(img, dump, blobs);
            return;
        }
        if (mode == "bubbles")
        {
            long pageArea = (long)W * (long)H;
            /* minside / minarea arrive in page points, the analysis runs in pixels */
            List<Result> bubbles = Bubbles(pad, hFrac, scale, minSide * scale,
                                           minArea * scale * scale,
                                           maxAspect, maxAreaFrac * pageArea, minRingInk, minRectFill);
            json.Append("{\"mode\":\"bubbles\",\"bubbles\":[");
            for (int i = 0; i < bubbles.Count; i++)
            {
                if (i > 0) json.Append(',');
                json.Append(ToJson(bubbles[i]));
            }
            json.Append("]}");
            File.WriteAllText(resPath, json.ToString(), new UTF8Encoding(false));
            if (dump != null) WriteBubbleDump(img, dump, bubbles);
            return;
        }
        json.Append("{\"results\":[");
        for (int n = 0; n < rects.Count; n++)
        {
            if (n > 0) json.Append(',');
            Result r = (mode == "box") ? DetectBox(rects[n], pad, scale, whiteFrac)
                                        : DetectLocal(rects[n], pad, hFrac, scale);
            if (n == 0 && s_dumpPath != null && s_lobe != null) WriteDump(img, s_dumpPath);
            json.Append(ToJson(r));
        }
        json.Append("]}");
        File.WriteAllText(resPath, json.ToString(), new UTF8Encoding(false));
    }

    static Bitmap Load24(string path)
    {
        using (Bitmap src = new Bitmap(path))
        {
            Bitmap dst = new Bitmap(src.Width, src.Height, PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(dst))
                g.DrawImage(src, 0, 0, src.Width, src.Height);
            return dst;
        }
    }

    // paper pixel survives only when all four neighbours are paper as well
    static void ErodeWhite()
    {
        byte[] tmp = new byte[W * H];
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
            {
                int i = y * W + x;
                if (mask[i] == 0) continue;
                if (x == 0 || y == 0 || x == W - 1 || y == H - 1) continue;
                if (mask[i - 1] == 1 && mask[i + 1] == 1 && mask[i - W] == 1 && mask[i + W] == 1) tmp[i] = 1;
            }
        mask = tmp;
    }

    static void LabelComponents()
    {
        labels = new int[W * H];
        int[] stack = new int[W * H];
        int next = 0;
        for (int i = 0; i < W * H; i++)
        {
            if (mask[i] == 0 || labels[i] != 0) continue;
            next++;
            Comp c = new Comp();
            c.id = next;
            int sp = 0;
            stack[sp++] = i;
            labels[i] = next;
            while (sp > 0)
            {
                int p = stack[--sp];
                int x = p % W, y = p / W;
                c.area++;
                c.sumX += x; c.sumY += y;
                if (x < c.minX) c.minX = x;
                if (y < c.minY) c.minY = y;
                if (x > c.maxX) c.maxX = x;
                if (y > c.maxY) c.maxY = y;
                if (x == 0 || y == 0 || x == W - 1 || y == H - 1) c.touchesBorder = true;
                if (x > 0 && mask[p - 1] == 1 && labels[p - 1] == 0) { labels[p - 1] = next; stack[sp++] = p - 1; }
                if (x < W - 1 && mask[p + 1] == 1 && labels[p + 1] == 0) { labels[p + 1] = next; stack[sp++] = p + 1; }
                if (y > 0 && mask[p - W] == 1 && labels[p - W] == 0) { labels[p - W] = next; stack[sp++] = p - W; }
                if (y < H - 1 && mask[p + W] == 1 && labels[p + W] == 0) { labels[p + W] = next; stack[sp++] = p + W; }
            }
            comps.Add(c);
        }
    }

    static int PickLabel(Rect r)
    {
        Dictionary<int, int> votes = new Dictionary<int, int>();
        int yStart = (int)Math.Max(0, r.y1), yEnd = (int)Math.Min(H - 1, r.y2);
        int xStart = (int)Math.Max(0, r.x1), xEnd = (int)Math.Min(W - 1, r.x2);
        for (int y = yStart; y <= yEnd; y += 3)
            for (int x = xStart; x <= xEnd; x += 3)
            {
                int l = labels[y * W + x];
                if (l == 0) continue;
                int count;
                votes.TryGetValue(l, out count);
                votes[l] = count + 1;
            }

        int best = 0, bestVotes = 0;
        foreach (KeyValuePair<int, int> kv in votes)
        {
            Comp c = comps[kv.Key - 1];
            if (c.area > 0.18 * W * H) continue;      // page paper, not a bubble
            if (kv.Value > bestVotes) { bestVotes = kv.Value; best = kv.Key; }
        }
        if (best != 0) return best;

        double bestD = double.MaxValue;
        foreach (Comp c in comps)
        {
            if (c.area < 400 || c.area > 0.18 * W * H) continue;
            double dx = c.Cx - r.Cx, dy = c.Cy - r.Cy;
            double dd = dx * dx + dy * dy;
            if (dd < bestD) { bestD = dd; best = c.id; }
        }
        return best;
    }

    // ---------------------------------------------------------------- detect

    static Result Detect(Rect r, double padFraction, double hFrac, double scale)
    {
        Result res = new Result();
        res.center[0] = r.Cx / scale; res.center[1] = r.Cy / scale;
        res.bbox = new double[] { r.x1 / scale, r.y1 / scale, r.x2 / scale, r.y2 / scale };
        res.fitRect = new double[] { r.x1 / scale, r.y1 / scale, r.x2 / scale, r.y2 / scale };

        int id = PickLabel(r);
        if (id == 0) { res.dbg = "no paper under the frame"; return res; }

        Comp c = comps[id - 1];
        res.area = c.area;

        int x0 = Math.Max(0, c.minX - 2), y0 = Math.Max(0, c.minY - 2);
        int x1 = Math.Min(W - 1, c.maxX + 2), y1 = Math.Min(H - 1, c.maxY + 2);
        int lw = x1 - x0 + 1, lh = y1 - y0 + 1;

        bool[] inside = new bool[lw * lh];
        for (int y = 0; y < lh; y++)
            for (int x = 0; x < lw; x++)
                inside[y * lw + x] = labels[(y0 + y) * W + (x0 + x)] == id;

        // fill holes: everything not reachable from the box border is paper that
        // the old lettering enclosed - keep it as printable area
        bool[] outside = new bool[lw * lh];
        int[] stack = new int[lw * lh];
        int sp = 0;
        for (int x = 0; x < lw; x++) { Seed(outside, stack, ref sp, inside, lw, lh, x, 0); Seed(outside, stack, ref sp, inside, lw, lh, x, lh - 1); }
        for (int y = 0; y < lh; y++) { Seed(outside, stack, ref sp, inside, lw, lh, 0, y); Seed(outside, stack, ref sp, inside, lw, lh, lw - 1, y); }
        while (sp > 0)
        {
            int p = stack[--sp];
            int x = p % lw, y = p / lw;
            Seed(outside, stack, ref sp, inside, lw, lh, x - 1, y);
            Seed(outside, stack, ref sp, inside, lw, lh, x + 1, y);
            Seed(outside, stack, ref sp, inside, lw, lh, x, y - 1);
            Seed(outside, stack, ref sp, inside, lw, lh, x, y + 1);
        }
        for (int i = 0; i < inside.Length; i++)
            if (!inside[i] && !outside[i]) inside[i] = true;

        float[] d = Chamfer(inside, lw, lh);
        float maxD = 0;
        for (int i = 0; i < d.Length; i++) if (d[i] > maxD) maxD = d[i];

        // h-maxima: seeds are the domes, so a tail or a waist cannot become a
        // bubble of its own
        List<int> reps; List<float> cMax;
        int coreCount = HMaximaSeeds(d, inside, lw, lh, (float)(hFrac * maxD), out reps, out cMax);
        if (coreCount == 0)
        {
            int mi = 0;
            float mv = -1;
            for (int i = 0; i < d.Length; i++) if (d[i] > mv) { mv = d[i]; mi = i; }
            reps.Add(mi); cMax.Add(mv); coreCount = 1;
        }

        int[] ws; Dictionary<long, float> saddles;
        Watershed(d, inside, lw, lh, reps, out ws, out saddles);

        UnionFind uf = new UnionFind(coreCount);
        MergeBasins(uf, saddles, cMax, 0.99f);

        // the seed that owns the frame
        int[] votes = new int[coreCount];
        int fx0 = (int)Math.Max(0, r.x1 - x0), fx1 = (int)Math.Min(lw - 1, r.x2 - x0);
        int fy0 = (int)Math.Max(0, r.y1 - y0), fy1 = (int)Math.Min(lh - 1, r.y2 - y0);
        for (int y = fy0; y <= fy1; y += 2)
            for (int x = fx0; x <= fx1; x += 2)
            {
                int l = ws[y * lw + x];
                if (l >= 0) votes[l]++;
            }
        int bestCore = -1, bestVote = 0;
        for (int k = 0; k < coreCount; k++) if (votes[k] > bestVote) { bestVote = votes[k]; bestCore = k; }
        if (bestCore < 0)
        {
            double rcx = (r.x1 + r.x2) / 2 - x0, rcy = (r.y1 + r.y2) / 2 - y0;
            double bd = double.MaxValue;
            for (int k = 0; k < coreCount; k++)
            {
                int p = reps[k];
                double dx = p % lw - rcx, dy = p / lw - rcy;
                double dd = dx * dx + dy * dy;
                if (dd < bd) { bd = dd; bestCore = k; }
            }
        }
        if (bestCore < 0) bestCore = 0;

        int root = uf.Find(bestCore);
        long lobeArea = 0;
        bool[] lobe = new bool[lw * lh];
        for (int i = 0; i < ws.Length; i++)
        {
            if (!inside[i] || ws[i] < 0) continue;
            if (uf.Find(ws[i]) == root) { lobe[i] = true; lobeArea++; }
        }
        if (lobeArea == 0) { lobe = inside; lobeArea = c.area; }

        float[] dl = Chamfer(lobe, lw, lh);

        int bx0 = lw, by0 = lh, bx1 = -1, by1 = -1;
        for (int y = 0; y < lh; y++)
            for (int x = 0; x < lw; x++)
                if (lobe[y * lw + x])
                {
                    if (x < bx0) bx0 = x;
                    if (y < by0) by0 = y;
                    if (x > bx1) bx1 = x;
                    if (y > by1) by1 = y;
                }
        if (bx1 < 0) { res.dbg = "empty lobe"; return res; }

        double bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
        double shortSide = Math.Min(bw, bh);
        double r14 = Math.Max(4.0, 0.14 * shortSide);
        double padPx = Math.Max(2.0, padFraction * shortSide);

        float maxL = 0;
        for (int i = 0; i < dl.Length; i++) if (dl[i] > maxL) maxL = dl[i];

        double sx = 0, sy = 0; long nBody = 0;
        int maxI = 0;
        for (int i = 0; i < dl.Length; i++)
        {
            if (dl[i] >= r14) { sx += i % lw; sy += i / lw; nBody++; }
            if (dl[i] >= maxL) maxI = i;
        }
        double cx, cy;
        if (nBody > 0) { cx = sx / nBody; cy = sy / nBody; }
        else { cx = maxI % lw; cy = maxI / lw; }

        int icx = (int)Math.Round(cx), icy = (int)Math.Round(cy);
        if (icx < 0 || icy < 0 || icx >= lw || icy >= lh || dl[icy * lw + icx] < padPx)
        {
            cx = maxI % lw; cy = maxI / lw;
            icx = (int)Math.Round(cx); icy = (int)Math.Round(cy);
        }

        res.center[0] = (x0 + cx) / scale;
        res.center[1] = (y0 + cy) / scale;
        res.radius = maxL / scale;
        res.bbox[0] = (x0 + bx0) / scale;
        res.bbox[1] = (y0 + by0) / scale;
        res.bbox[2] = (x0 + bx1 + 1) / scale;
        res.bbox[3] = (y0 + by1 + 1) / scale;

        double maxHW = Math.Min(cx, lw - 1 - cx), maxHH = Math.Min(cy, lh - 1 - cy);
        double scaleS = BinaryScale(dl, lw, lh, cx, cy, maxHW, maxHH, padPx);
        double halfW = maxHW * scaleS, halfH = maxHH * scaleS;

        double lo = scaleS, hi = 1.0, bestW = scaleS;
        for (int it = 0; it < 14; it++)
        {
            double mid = (lo + hi) / 2;
            if (RectInside(dl, lw, lh, cx, cy, maxHW * mid, halfH, padPx)) { bestW = mid; lo = mid; } else hi = mid;
        }
        halfW = maxHW * bestW;
        lo = scaleS; hi = 1.0; double bestH = scaleS;
        for (int it = 0; it < 14; it++)
        {
            double mid = (lo + hi) / 2;
            if (RectInside(dl, lw, lh, cx, cy, halfW, maxHH * mid, padPx)) { bestH = mid; lo = mid; } else hi = mid;
        }
        halfH = maxHH * bestH;

        res.fitRect[0] = (x0 + cx - halfW) / scale;
        res.fitRect[1] = (y0 + cy - halfH) / scale;
        res.fitRect[2] = (x0 + cx + halfW) / scale;
        res.fitRect[3] = (y0 + cy + halfH) / scale;

        int PN = 120;
        double stepRad = 2 * Math.PI / PN;
        double maxR = Math.Sqrt(bw * bw + bh * bh) + 2;
        for (int k = 0; k < PN; k++)
        {
            double ang = k * stepRad;
            double dx = Math.Cos(ang), dy = Math.Sin(ang);
            double lastR = 0;
            for (double rr = 1; rr < maxR; rr += 1.0)
            {
                int px = (int)Math.Round(cx + dx * rr), py = (int)Math.Round(cy + dy * rr);
                if (px < 0 || py < 0 || px >= lw || py >= lh) break;
                if (dl[py * lw + px] < padPx) break;
                lastR = rr;
            }
            res.poly.Add(new double[] { (x0 + cx + dx * lastR) / scale, (y0 + cy + dy * lastR) / scale });
        }
        for (int pass = 0; pass < 2; pass++)
        {
            List<double[]> sm = new List<double[]>();
            for (int k = 0; k < res.poly.Count; k++)
            {
                double[] a = res.poly[(k + res.poly.Count - 1) % res.poly.Count];
                double[] b = res.poly[k];
                double[] e = res.poly[(k + 1) % res.poly.Count];
                sm.Add(new double[] { (a[0] + 2 * b[0] + e[0]) / 4, (a[1] + 2 * b[1] + e[1]) / 4 });
            }
            res.poly = sm;
        }

        if (s_dumpPath != null)
        {
            s_lobe = lobe; s_d = dl; s_lw = lw; s_lh = lh;
            s_x0 = x0; s_y0 = y0; s_cx = cx; s_cy = cy;
            s_padPx = padPx; s_r14 = r14;
            s_fit = (double[])res.fitRect.Clone();
        }

        res.dbg = "comp=" + c.area + " lobe=" + lobeArea + " seeds=" + coreCount
            + " shortSide=" + N(shortSide) + " r14=" + N(r14) + " pad=" + N(padPx)
            + " maxD=" + N(maxL) + " fit=" + N(res.fitRect[2] - res.fitRect[0]) + "x" + N(res.fitRect[3] - res.fitRect[1]);
        res.ok = true;
        return res;
    }

    // ------------------------------------------------------------ morphology

    static int HMaximaSeeds(float[] d, bool[] inside, int lw, int lh, float h, out List<int> reps, out List<float> cMax)
    {
        reps = new List<int>();
        cMax = new List<float>();
        if (d.Length == 0) return 0;

        // marker: max(d - h, 0); reconstruct it under d (max-priority relaxation)
        float[] rec = new float[d.Length];
        Heap heap = new Heap(1 << 12);
        for (int i = 0; i < d.Length; i++)
        {
            if (!inside[i]) continue;
            float m = d[i] - h;
            if (m <= 0) continue;
            rec[i] = m;
            heap.Push(m, i);
        }
        while (heap.Count > 0)
        {
            float key; int p;
            heap.Pop(out key, out p);
            if (key < rec[p]) continue;
            int x = p % lw, y = p / lw;
            RelaxRec(rec, heap, d, lw, lh, p, x - 1, y);
            RelaxRec(rec, heap, d, lw, lh, p, x + 1, y);
            RelaxRec(rec, heap, d, lw, lh, p, x, y - 1);
            RelaxRec(rec, heap, d, lw, lh, p, x, y + 1);
        }

        // components of the dome (d - rec > 0) are the seeds
        int[] lab = new int[lw * lh];
        int[] stack = new int[lw * lh];
        int next = 0;
        for (int i = 0; i < d.Length; i++)
        {
            if (!inside[i] || lab[i] != 0) continue;
            if (d[i] - rec[i] <= 0.5f) continue;
            next++;
            int sp = 0;
            stack[sp++] = i; lab[i] = next;
            int rep = i; float mx = -1;
            long cnt = 0;
            while (sp > 0)
            {
                int p = stack[--sp];
                int x = p % lw, y = p / lw;
                cnt++;
                if (d[p] > mx) { mx = d[p]; rep = p; }
                if (x > 0 && lab[p - 1] == 0 && inside[p - 1] && d[p - 1] - rec[p - 1] > 0.5f) { lab[p - 1] = next; stack[sp++] = p - 1; }
                if (x < lw - 1 && lab[p + 1] == 0 && inside[p + 1] && d[p + 1] - rec[p + 1] > 0.5f) { lab[p + 1] = next; stack[sp++] = p + 1; }
                if (y > 0 && lab[p - lw] == 0 && inside[p - lw] && d[p - lw] - rec[p - lw] > 0.5f) { lab[p - lw] = next; stack[sp++] = p - lw; }
                if (y < lh - 1 && lab[p + lw] == 0 && inside[p + lw] && d[p + lw] - rec[p + lw] > 0.5f) { lab[p + lw] = next; stack[sp++] = p + lw; }
            }
            reps.Add(rep);
            cMax.Add(mx);
        }
        return reps.Count;
    }

    static void RelaxRec(float[] rec, Heap heap, float[] d, int lw, int lh, int p, int x, int y)
    {
        if (x < 0 || y < 0 || x >= lw || y >= lh) return;
        int q = y * lw + x;
        float v = Math.Min(d[q], rec[p]);
        if (v > rec[q] + 0.01f) { rec[q] = v; heap.Push(v, q); }
    }

    static void Watershed(float[] d, bool[] inside, int lw, int lh, List<int> reps,
        out int[] ws, out Dictionary<long, float> saddles)
    {
        ws = new int[lw * lh];
        for (int i = 0; i < ws.Length; i++) ws[i] = -1;
        saddles = new Dictionary<long, float>();
        Heap heap = new Heap(1 << 12);
        for (int k = 0; k < reps.Count; k++)
        {
            ws[reps[k]] = k;
            heap.Push(d[reps[k]], reps[k]);
        }
        while (heap.Count > 0)
        {
            float key; int p;
            heap.Pop(out key, out p);
            int lab = ws[p];
            int x = p % lw, y = p / lw;
            Relax(ws, saddles, heap, d, lw, lh, p, x - 1, y, lab, d[p]);
            Relax(ws, saddles, heap, d, lw, lh, p, x + 1, y, lab, d[p]);
            Relax(ws, saddles, heap, d, lw, lh, p, x, y - 1, lab, d[p]);
            Relax(ws, saddles, heap, d, lw, lh, p, x, y + 1, lab, d[p]);
        }
    }

    static void Relax(int[] ws, Dictionary<long, float> saddles, Heap heap, float[] d, int lw, int lh,
        int p, int x, int y, int lab, float level)
    {
        if (x < 0 || y < 0 || x >= lw || y >= lh) return;
        int q = y * lw + x;
        if (ws[q] < 0)
        {
            ws[q] = lab;
            heap.Push(d[q], q);
        }
        else if (ws[q] != lab)
        {
            int a = ws[q] < lab ? ws[q] : lab;
            int b = ws[q] < lab ? lab : ws[q];
            long key = ((long)b << 21) | (long)a;
            float old;
            if (!saddles.TryGetValue(key, out old) || level > old) saddles[key] = level;
        }
    }

    static void MergeBasins(UnionFind uf, Dictionary<long, float> saddles, List<float> cMax, float frac)
    {
        if (saddles == null || cMax == null) return;
        float[] mx = new float[uf.Count];
        for (int k = 0; k < cMax.Count && k < mx.Length; k++) mx[k] = cMax[k];
        for (int pass = 0; pass < 3; pass++)
        {
            foreach (KeyValuePair<long, float> kv in saddles)
            {
                int a = (int)(kv.Key & 0x1FFFFF), b = (int)(kv.Key >> 21);
                int ra = uf.Find(a), rb = uf.Find(b);
                if (ra == rb) continue;
                if (kv.Value >= frac * Math.Min(mx[ra], mx[rb]))
                {
                    uf.Union(ra, rb);
                    int nr = uf.Find(ra);
                    mx[nr] = Math.Max(mx[ra], mx[rb]);
                }
            }
        }
    }

    class UnionFind
    {
        int[] p;
        public UnionFind(int n) { p = new int[n]; for (int i = 0; i < n; i++) p[i] = i; }
        public int Count { get { return p.Length; } }
        public int Find(int x) { while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; } return x; }
        public void Union(int a, int b) { int ra = Find(a), rb = Find(b); if (ra != rb) p[rb] = ra; }
    }

    class Heap
    {
        float[] keys; int[] vals; int n;
        public Heap(int cap) { keys = new float[cap]; vals = new int[cap]; }
        public int Count { get { return n; } }
        void Grow() { int c = keys.Length * 2; Array.Resize(ref keys, c); Array.Resize(ref vals, c); }
        public void Push(float k, int v)
        {
            if (n == keys.Length) Grow();
            int i = n++;
            keys[i] = k; vals[i] = v;
            while (i > 0)
            {
                int pa = (i - 1) / 2;
                if (keys[pa] >= keys[i]) break;
                Swap(pa, i); i = pa;
            }
        }
        public void Pop(out float k, out int v)
        {
            k = keys[0]; v = vals[0];
            n--;
            if (n > 0)
            {
                keys[0] = keys[n]; vals[0] = vals[n];
                int i = 0;
                while (true)
                {
                    int l = 2 * i + 1; if (l >= n) break;
                    int r = l + 1; int b = l;
                    if (r < n && keys[r] > keys[l]) b = r;
                    if (keys[b] <= keys[i]) break;
                    Swap(i, b); i = b;
                }
            }
        }
        void Swap(int a, int b)
        {
            float tk = keys[a]; keys[a] = keys[b]; keys[b] = tk;
            int tv = vals[a]; vals[a] = vals[b]; vals[b] = tv;
        }
    }

    static float[] Chamfer(bool[] inside, int lw, int lh)
    {
        float INF = 1e9f;
        float sq = 1.41421356f;
        float[] d = new float[lw * lh];
        for (int i = 0; i < d.Length; i++) d[i] = inside[i] ? INF : 0f;
        for (int y = 0; y < lh; y++)
            for (int x = 0; x < lw; x++)
            {
                int i = y * lw + x;
                if (!inside[i]) continue;
                float v = d[i];
                if (x > 0) v = Math.Min(v, d[i - 1] + 1);
                if (y > 0) v = Math.Min(v, d[i - lw] + 1);
                if (x > 0 && y > 0) v = Math.Min(v, d[i - lw - 1] + sq);
                if (x < lw - 1 && y > 0) v = Math.Min(v, d[i - lw + 1] + sq);
                d[i] = v;
            }
        for (int y = lh - 1; y >= 0; y--)
            for (int x = lw - 1; x >= 0; x--)
            {
                int i = y * lw + x;
                if (!inside[i]) continue;
                float v = d[i];
                if (x < lw - 1) v = Math.Min(v, d[i + 1] + 1);
                if (y < lh - 1) v = Math.Min(v, d[i + lw] + 1);
                if (x < lw - 1 && y < lh - 1) v = Math.Min(v, d[i + lw + 1] + sq);
                if (x > 0 && y < lh - 1) v = Math.Min(v, d[i + lw - 1] + sq);
                d[i] = v;
            }
        return d;
    }

    static void Seed(bool[] outside, int[] stack, ref int sp, bool[] inside, int lw, int lh, int x, int y)
    {
        if (x < 0 || y < 0 || x >= lw || y >= lh) return;
        int i = y * lw + x;
        if (inside[i] || outside[i]) return;
        outside[i] = true;
        stack[sp++] = i;
    }

    static double BinaryScale(float[] d, int lw, int lh, double cx, double cy, double maxHW, double maxHH, double padPx)
    {
        double lo = 0, hi = 1;
        for (int it = 0; it < 14; it++)
        {
            double mid = (lo + hi) / 2;
            if (RectInside(d, lw, lh, cx, cy, maxHW * mid, maxHH * mid, padPx)) lo = mid; else hi = mid;
        }
        return lo;
    }

    static bool RectInside(float[] d, int lw, int lh, double cx, double cy, double hw, double hh, double padPx)
    {
        if (hw <= 1 || hh <= 1) return false;
        int x0 = (int)Math.Ceiling(cx - hw), x1 = (int)Math.Floor(cx + hw);
        int y0 = (int)Math.Ceiling(cy - hh), y1 = (int)Math.Floor(cy + hh);
        if (x0 < 0 || y0 < 0 || x1 >= lw || y1 >= lh) return false;
        for (int y = y0; y <= y1; y += 2)
            for (int x = x0; x <= x1; x += 2)
                if (d[y * lw + x] < padPx) return false;
        if (d[y0 * lw + x0] < padPx || d[y0 * lw + x1] < padPx || d[y1 * lw + x0] < padPx || d[y1 * lw + x1] < padPx) return false;
        if (d[((y0 + y1) / 2) * lw + x0] < padPx || d[((y0 + y1) / 2) * lw + x1] < padPx) return false;
        if (d[y0 * lw + (x0 + x1) / 2] < padPx || d[y1 * lw + (x0 + x1) / 2] < padPx) return false;
        return true;
    }

    // ------------------------------------------------------------------ dump

    static void WriteDump(string imgPath, string outPath)
    {
        using (Bitmap src = Load24(imgPath))
        {
            Bitmap dst = new Bitmap(src.Width, src.Height, PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(dst))
            {
                g.DrawImage(src, 0, 0);
                for (int y = 0; y < s_lh; y++)
                    for (int x = 0; x < s_lw; x++)
                    {
                        int i = y * s_lw + x;
                        if (!s_lobe[i]) continue;
                        float dd = s_d[i];
                        Color col;
                        if (dd >= s_r14) col = Color.FromArgb(0, 90, 255);
                        else if (dd >= s_padPx) col = Color.FromArgb(0, 180, 70);
                        else col = Color.FromArgb(255, 170, 0);
                        dst.SetPixel(s_x0 + x, s_y0 + y, col);
                    }
                using (Pen pen = new Pen(Color.Magenta, 2))
                    g.DrawRectangle(pen, (float)(s_fit[0] * s_scale), (float)(s_fit[1] * s_scale),
                        (float)((s_fit[2] - s_fit[0]) * s_scale), (float)((s_fit[3] - s_fit[1]) * s_scale));
                using (Pen pen = new Pen(Color.Red, 3))
                {
                    int px = (int)(s_x0 + s_cx), py = (int)(s_y0 + s_cy);
                    g.DrawLine(pen, px - 24, py, px + 24, py);
                    g.DrawLine(pen, px, py - 24, px, py + 24);
                }
            }
            dst.Save(outPath, ImageFormat.Png);
        }
    }

    // ------------------------------------------------------------ whole page

    /* Every bubble on the page, with no text frame needed. Same lobe pipeline
       as Detect(), but each watershed basin is a candidate instead of the one
       that owns a frame. Used by "检测整页气泡 / 从气泡铺框". */
    /* bright regions enclosed by ink: the workhorse for already-lettered art.
       Page margin is bright too but it touches the border, so it is the one
       blob that cannot be a bubble; glyphs inside a bubble are holes and get
       filled back in before the metrics are taken. */
    static List<Result> Blobs(double padFraction, double scale, double minSidePx, double minAreaPx,
                              double maxAspect, double maxAreaPx, double minFill, int lightThr, int dilate)
    {
        List<Result> found = new List<Result>();
        bool[] light = new bool[W * H];
        for (int i = 0; i < light.Length; i++) light[i] = lum[i] >= lightThr;
        bool[] ink = new bool[W * H];
        for (int i = 0; i < ink.Length; i++) ink[i] = !light[i];
        for (int it = 0; it < dilate; it++) Dilate(ink);

        int[] lab = new int[W * H];
        for (int i = 0; i < lab.Length; i++) lab[i] = -1;
        int[] queue = new int[W * H];
        List<Comp> list = new List<Comp>();
        for (int sy0 = 0; sy0 < H; sy0++)
            for (int sx0 = 0; sx0 < W; sx0++)
            {
                int idx = sy0 * W + sx0;
                if (ink[idx] || lab[idx] >= 0) continue;
                Comp c = new Comp();
                int head = 0, tail = 0;
                c.id = list.Count;
                queue[tail++] = idx; lab[idx] = c.id;
                while (head < tail)
                {
                    int p = queue[head++];
                    int x = p % W, y = p / W;
                    c.area++; c.sumX += x; c.sumY += y;
                    if (x < c.minX) c.minX = x;
                    if (y < c.minY) c.minY = y;
                    if (x > c.maxX) c.maxX = x;
                    if (y > c.maxY) c.maxY = y;
                    if (x == 0 || y == 0 || x == W - 1 || y == H - 1) c.touchesBorder = true;
                    if (x > 0) { int q = p - 1; if (!ink[q] && lab[q] < 0) { lab[q] = c.id; queue[tail++] = q; } }
                    if (x < W - 1) { int q = p + 1; if (!ink[q] && lab[q] < 0) { lab[q] = c.id; queue[tail++] = q; } }
                    if (y > 0) { int q = p - W; if (!ink[q] && lab[q] < 0) { lab[q] = c.id; queue[tail++] = q; } }
                    if (y < H - 1) { int q = p + W; if (!ink[q] && lab[q] < 0) { lab[q] = c.id; queue[tail++] = q; } }
                }
                list.Add(c);
            }

        for (int k = 0; k < list.Count; k++)
        {
            Comp c = list[k];
            if (c.area < minAreaPx || c.area > maxAreaPx) continue;
            int bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
            bool edge = c.touchesBorder;
            if (edge)
            {
                /* A balloon cut by the page trim is still a balloon: its white
                   interior ends at the image border. The page margin is paper
                   too, but it spans the page or fills a large rectangle; only
                   compact border regions are accepted. */
                if (bw > 0.50 * W || bh > 0.50 * H) continue;
            }
            if (bw < minSidePx || bh < minSidePx) continue;
            if (Math.Max(bw, bh) > maxAspect * Math.Min(bw, bh)) continue;
            double fill = (double)c.area / ((long)bw * bh);
            if (fill < minFill) continue;

            int x0 = Math.Max(0, c.minX - 2), y0 = Math.Max(0, c.minY - 2);
            int x1 = Math.Min(W - 1, c.maxX + 2), y1 = Math.Min(H - 1, c.maxY + 2);
            int lw = x1 - x0 + 1, lh = y1 - y0 + 1;
            bool[] region = new bool[lw * lh];
            for (int y = 0; y < lh; y++)
                for (int x = 0; x < lw; x++)
                    region[y * lw + x] = lab[(y0 + y) * W + (x0 + x)] == c.id;
            FillHoles(region, lw, lh);

            Result res = new Result();
            if (!Metricise(res, region, lw, lh, x0, y0, padFraction, scale)) continue;

            int fx0 = Math.Max(0, (int)Math.Round(res.fitRect[0] * scale)), fy0 = Math.Max(0, (int)Math.Round(res.fitRect[1] * scale));
            int fx1 = Math.Min(W, (int)Math.Round(res.fitRect[2] * scale)), fy1 = Math.Min(H, (int)Math.Round(res.fitRect[3] * scale));
            long tot = 0, inked = 0;
            for (int yy = fy0; yy < fy1; yy++)
                for (int xx = fx0; xx < fx1; xx++) { tot++; if (ink[yy * W + xx]) inked++; }
            res.fitInk = tot > 0 ? (double)inked / tot : 0;
            res.ok = true;
            res.leak = edge;
            res.area = c.area;
            res.openRays = 0;
            res.dbg = "blob fill=" + N(fill) + (edge ? " edge=1" : "");
            found.Add(res);
        }
        return found;
    }

    static void Dilate(bool[] m)
    {
        bool[] tmp = new bool[m.Length];
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
            {
                int i = y * W + x;
                if (!m[i]) continue;
                tmp[i] = true;
                if (x > 0) tmp[i - 1] = true;
                if (x < W - 1) tmp[i + 1] = true;
                if (y > 0) tmp[i - W] = true;
                if (y < H - 1) tmp[i + W] = true;
            }
        for (int i = 0; i < m.Length; i++) m[i] = tmp[i];
    }

    static List<Result> Bubbles(double padFraction, double hFrac, double scale,
                                double minSidePx, double minAreaPx, double maxAspect,
                                double maxAreaPx, double minRingInk, double minRectFill)
    {
        List<Result> found = new List<Result>();
        for (int cid = 1; cid <= comps.Count; cid++)
        {
            Comp c = comps[cid - 1];
            if (c.area < minAreaPx) continue;
            /* the page margin is paper too - it is the one blob that is not a
               bubble, and skipping it early keeps the pass fast */
            if (c.touchesBorder && c.area > 0.2 * W * H) continue;

            int x0 = Math.Max(0, c.minX - 2), y0 = Math.Max(0, c.minY - 2);
            int x1 = Math.Min(W - 1, c.maxX + 2), y1 = Math.Min(H - 1, c.maxY + 2);
            int lw = x1 - x0 + 1, lh = y1 - y0 + 1;

            bool[] inside = new bool[lw * lh];
            for (int y = 0; y < lh; y++)
                for (int x = 0; x < lw; x++)
                    inside[y * lw + x] = labels[(y0 + y) * W + (x0 + x)] == cid;

            bool[] outside = new bool[lw * lh];
            int[] stack = new int[lw * lh];
            int sp = 0;
            for (int x = 0; x < lw; x++) { Seed(outside, stack, ref sp, inside, lw, lh, x, 0); Seed(outside, stack, ref sp, inside, lw, lh, x, lh - 1); }
            for (int y = 0; y < lh; y++) { Seed(outside, stack, ref sp, inside, lw, lh, 0, y); Seed(outside, stack, ref sp, inside, lw, lh, lw - 1, y); }
            while (sp > 0)
            {
                int p = stack[--sp];
                int x = p % lw, y = p / lw;
                Seed(outside, stack, ref sp, inside, lw, lh, x - 1, y);
                Seed(outside, stack, ref sp, inside, lw, lh, x + 1, y);
                Seed(outside, stack, ref sp, inside, lw, lh, x, y - 1);
                Seed(outside, stack, ref sp, inside, lw, lh, x, y + 1);
            }
            for (int i = 0; i < inside.Length; i++)
                if (!inside[i] && !outside[i]) inside[i] = true;

            float[] d = Chamfer(inside, lw, lh);
            float maxD = 0;
            for (int i = 0; i < d.Length; i++) if (d[i] > maxD) maxD = d[i];
            if (maxD <= 0) continue;

            List<int> reps; List<float> cMax;
            int coreCount = HMaximaSeeds(d, inside, lw, lh, (float)(hFrac * maxD), out reps, out cMax);
            if (coreCount == 0) continue;

            int[] ws; Dictionary<long, float> saddles;
            Watershed(d, inside, lw, lh, reps, out ws, out saddles);
            UnionFind uf = new UnionFind(coreCount);
            MergeBasins(uf, saddles, cMax, 0.99f);

            int[] rootIdx = new int[coreCount];
            for (int k = 0; k < coreCount; k++) rootIdx[k] = -1;
            int nRoots = 0;
            for (int k = 0; k < coreCount; k++)
            {
                int r = uf.Find(k);
                if (rootIdx[r] < 0) rootIdx[r] = nRoots++;
            }

            /* pass 1: area, so hopeless basins never get a mask allocated */
            long[] lobeAreas = new long[nRoots];
            for (int i = 0; i < ws.Length; i++)
            {
                if (!inside[i] || ws[i] < 0) continue;
                lobeAreas[rootIdx[uf.Find(ws[i])]]++;
            }
            bool[] keep = new bool[nRoots];
            for (int k = 0; k < nRoots; k++)
                keep[k] = lobeAreas[k] >= minAreaPx && lobeAreas[k] <= maxAreaPx;

            /* pass 2: one mask per surviving basin */
            bool[][] lobes = new bool[nRoots][];
            for (int k = 0; k < nRoots; k++) if (keep[k]) lobes[k] = new bool[lw * lh];
            for (int i = 0; i < ws.Length; i++)
            {
                if (!inside[i] || ws[i] < 0) continue;
                int idx = rootIdx[uf.Find(ws[i])];
                if (keep[idx]) lobes[idx][i] = true;
            }

            for (int k = 0; k < nRoots; k++)
            {
                if (!keep[k]) continue;
                Result r = new Result();
                if (!Metricise(r, lobes[k], lw, lh, x0, y0, padFraction, scale)) continue;

                double bwPt = r.bbox[2] - r.bbox[0], bhPt = r.bbox[3] - r.bbox[1];
                double shortPx = Math.Min(bwPt, bhPt) * scale;
                double longPx = Math.Max(bwPt, bhPt) * scale;
                if (shortPx < minSidePx) continue;
                if (longPx / Math.Max(1.0, shortPx) > maxAspect) continue;

                double fill = lobeAreas[k] / Math.Max(1.0, (bwPt * scale) * (bhPt * scale));
                if (fill < 0.55) continue;
                /* a painted-over bubble is a clean white RECTANGLE: keep only
                   basins that fill their bounding box */
                if (minRectFill > 0 && fill < minRectFill) continue;
                /* a bubble is closed by its ink outline; rays that run away
                   mean the paper leaks into the panel background */
                if (r.openRays > 8) continue;

                /* ...and the shell just outside the body must actually meet ink:
                   a bubble is drawn with an outline, white pockets and panel
                   gutters are paper on every side and fail here. */
                bool[] inv = new bool[lw * lh];
                for (int ii = 0; ii < inv.Length; ii++) inv[ii] = !lobes[k][ii];
                float[] dOut = Chamfer(inv, lw, lh);
                long ringPx = 0, inkPx = 0;
                for (int ii = 0; ii < dOut.Length; ii++)
                {
                    if (!inv[ii] || dOut[ii] <= 0 || dOut[ii] > 28) continue;
                    ringPx++;
                    int gx = x0 + (ii % lw), gy = y0 + (ii / lw);
                    if (mask[gy * W + gx] == 0) inkPx++;
                }
                double inkRatio = ringPx > 0 ? (double)inkPx / ringPx : 0;
                if (inkRatio < minRingInk) continue;

                /* ink inside the safe box: a lettered bubble carries strokes,
                   a white cheek or paper pocket carries none */
                int fx0 = (int)Math.Round(r.fitRect[0] * scale), fy0 = (int)Math.Round(r.fitRect[1] * scale);
                int fx1 = (int)Math.Round(r.fitRect[2] * scale), fy1 = (int)Math.Round(r.fitRect[3] * scale);
                if (fx0 < 0) fx0 = 0; if (fy0 < 0) fy0 = 0;
                if (fx1 > W) fx1 = W; if (fy1 > H) fy1 = H;
                long tot = 0, ink = 0;
                for (int yy = fy0; yy < fy1; yy++)
                    for (int xx = fx0; xx < fx1; xx++) { tot++; if (mask[yy * W + xx] == 0) ink++; }
                r.fitInk = tot > 0 ? (double)ink / tot : 0;

                r.area = lobeAreas[k];
                r.ok = true;
                r.dbg = "basin=" + r.area + " fill=" + N(fill) + " aspect=" + N(longPx / Math.Max(1.0, shortPx))
                      + " open=" + r.openRays;
                found.Add(r);
            }
        }
        return found;
    }

    /* ---------------------------------------------------------------- */
    /* Frame mode: the TypeR magic-wand move. Flood the paper from the frame
       centre inside a window around the frame. The connected paper region is
       the bubble the frame sits in; a tail is cut off by the same 14% rule,
       the centroid of the body becomes the target. Cheap: work stays local. */
    static Result DetectLocal(Rect r, double padFraction, double hFrac, double scale)
    {
        double wPt = r.x2 - r.x1, hPt = r.y2 - r.y1;
        double margin = Math.Max(24.0, 0.6 * Math.Max(wPt, hPt)) * scale;

        for (int attempt = 0; attempt < 3; attempt++)
        {
            int wx0 = Math.Max(0, (int)Math.Floor(r.x1 * scale - margin));
            int wy0 = Math.Max(0, (int)Math.Floor(r.y1 * scale - margin));
            int wx1 = Math.Min(W, (int)Math.Ceiling(r.x2 * scale + margin));
            int wy1 = Math.Min(H, (int)Math.Ceiling(r.y2 * scale + margin));
            int lw = wx1 - wx0, lh = wy1 - wy0;
            if (lw < 8 || lh < 8) return new Result();

            int sx = (int)Math.Round((r.x1 + r.x2) / 2 * scale);
            int sy = (int)Math.Round((r.y1 + r.y2) / 2 * scale);
            bool[] region = FloodWhite(wx0, wy0, lw, lh, sx, sy);
            if (region == null) { margin *= 1.7; continue; }

            bool onPageEdge = (wx0 <= 0 && wy0 <= 0 && wx1 >= W && wy1 >= H);
            if (!onPageEdge && RegionTouchesBorder(region, lw, lh))
            {
                margin *= 1.7;
                continue;
            }

            FillHoles(region, lw, lh);
            Result res = new Result();
            if (!Metricise(res, region, lw, lh, wx0, wy0, padFraction, scale)) { res.ok = false; return res; }

            /* ink inside the safe box, same measure the survey uses */
            int fx0 = Math.Max(0, (int)Math.Round(res.fitRect[0] * scale)), fy0 = Math.Max(0, (int)Math.Round(res.fitRect[1] * scale));
            int fx1 = Math.Min(W, (int)Math.Round(res.fitRect[2] * scale)), fy1 = Math.Min(H, (int)Math.Round(res.fitRect[3] * scale));
            long tot = 0, ink = 0;
            for (int yy = fy0; yy < fy1; yy++)
                for (int xx = fx0; xx < fx1; xx++) { tot++; if (mask[yy * W + xx] == 0) ink++; }

            res.fitInk = tot > 0 ? (double)ink / tot : 0;
            res.ok = true;
            res.area = Count(region);
            res.dbg = "local win=" + lw + "x" + lh + " band=" + N((double)res.area / Math.Max(1.0, lw * lh));
            return res;
        }
        return new Result();
    }

    static int Count(bool[] a) { int n = 0; for (int i = 0; i < a.Length; i++) if (a[i]) n++; return n; }

    /* 4-connected flood of white pixels inside the window, seeded at the frame
       centre (or the nearest white pixel when the centre itself is inked). */
    static bool[] FloodWhite(int wx0, int wy0, int lw, int lh, int sx, int sy)
    {
        int lx = sx - wx0, ly = sy - wy0;
        if (lx < 0 || ly < 0 || lx >= lw || ly >= lh) return null;
        if (mask[sy * W + sx] == 0)
        {
            bool found = false;
            for (int rad = 1; rad <= 24 && !found; rad++)
                for (int dy = -rad; dy <= rad && !found; dy++)
                    for (int dx = -rad; dx <= rad && !found; dx++)
                    {
                        int tx = lx + dx, ty = ly + dy;
                        if (!InWin(tx, ty, lw, lh)) continue;
                        if (mask[(wy0 + ty) * W + (wx0 + tx)] != 1) continue;
                        lx = tx; ly = ty; found = true;
                    }
            if (!found) return null;
        }

        bool[] done = new bool[lw * lh];
        int[] q = new int[lw * lh];
        int head = 0, tail = 0;
        int start = ly * lw + lx;
        done[start] = true;
        q[tail++] = start;
        while (head < tail)
        {
            int cur = q[head++];
            int cx = cur % lw, cy = cur / lw;
            if (cx > 0) TryPush(q, done, ref tail, cx - 1, cy, lw, wx0, wy0);
            if (cx < lw - 1) TryPush(q, done, ref tail, cx + 1, cy, lw, wx0, wy0);
            if (cy > 0) TryPush(q, done, ref tail, cx, cy - 1, lw, wx0, wy0);
            if (cy < lh - 1) TryPush(q, done, ref tail, cx, cy + 1, lw, wx0, wy0);
        }
        bool[] region = new bool[lw * lh];
        for (int i = 0; i < tail; i++) region[q[i]] = true;
        return region;
    }

    static void TryPush(int[] q, bool[] done, ref int tail, int nx, int ny, int lw, int wx0, int wy0)
    {
        int idx = ny * lw + nx;
        if (done[idx]) return;
        if (mask[(wy0 + ny) * W + (wx0 + nx)] != 1) return;
        done[idx] = true;
        q[tail++] = idx;
    }

    static bool InWin(int x, int y, int lw, int lh) { return x >= 0 && y >= 0 && x < lw && y < lh; }
    static bool RegionTouchesBorder(bool[] region, int lw, int lh)
    {
        for (int x = 0; x < lw; x++)
            if (region[x] || region[(lh - 1) * lw + x]) return true;
        for (int y = 0; y < lh; y++)
            if (region[y * lw] || region[y * lw + lw - 1]) return true;
        return false;
    }

    static void FillHoles(bool[] region, int lw, int lh)
    {
        bool[] outside = new bool[lw * lh];
        int[] q = new int[lw * lh];
        int head = 0, tail = 0;
        for (int x = 0; x < lw; x++)
        {
            if (!region[x] && !outside[x]) { outside[x] = true; q[tail++] = x; }
            int bottom = (lh - 1) * lw + x;
            if (!region[bottom] && !outside[bottom]) { outside[bottom] = true; q[tail++] = bottom; }
        }
        for (int y = 0; y < lh; y++)
        {
            if (!region[y * lw] && !outside[y * lw]) { outside[y * lw] = true; q[tail++] = y * lw; }
            if (!region[y * lw + lw - 1] && !outside[y * lw + lw - 1]) { outside[y * lw + lw - 1] = true; q[tail++] = y * lw + lw - 1; }
        }
        while (head < tail)
        {
            int cur = q[head++];
            int cx = cur % lw, cy = cur / lw;
            int[] nx = { cur - 1, cur + 1, cur - lw, cur + lw };
            int[] ny = { cy, cy, cy - 1, cy + 1 };
            int[] nxx = { cx - 1, cx + 1, cx, cx };
            for (int k = 0; k < 4; k++)
            {
                if (nx[k] < 0 || nx[k] >= q.Length || ny[k] < 0 || ny[k] >= lh || nxx[k] < 0 || nxx[k] >= lw) continue;
                if (outside[nx[k]] || region[nx[k]]) continue;
                outside[nx[k]] = true;
                q[tail++] = nx[k];
            }
        }
        for (int i = 0; i < region.Length; i++) if (!region[i] && !outside[i]) region[i] = true;
    }
    /* Geometry of one bubble body: centroid, safe rectangle, padded outline.
       Shared by Bubbles(); Detect() keeps its own inlined copy because it also
       records the dump overlay state. */
    /* ---------------------------------------------------------------- */
    /* Box mode: the bubble is a painted white rectangle (cleaned/redrawn
       bubbles have no outline left). Grow the frame's rectangle outwards
       while each new band stays white, then centre on that box. The right
       model for LP/retouch documents, where the ink-ring test can never
       fire because the outline was painted over. */
    static Result DetectBox(Rect r, double padFraction, double scale, double whiteFrac)
    {
        int x0 = Math.Max(0, (int)Math.Floor(r.x1)), y0 = Math.Max(0, (int)Math.Floor(r.y1));
        int x1 = Math.Min(W - 1, (int)Math.Ceiling(r.x2)), y1 = Math.Min(H - 1, (int)Math.Ceiling(r.y2));
        if (x1 - x0 < 3 || y1 - y0 < 3) return new Result();

        int step = 2, x0s = x0, y0s = y0, x1s = x1, y1s = y1;
        for (int guard = 0; guard < 4096; guard++)
        {
            int tx0 = x0, ty0 = y0, tx1 = x1, ty1 = y1;
            bool grew = false;
            if (y0 >= step && BandWhite(x0, y0 - step, x1, y0 - 1, whiteFrac)) { ty0 = y0 - step; grew = true; }
            if (y1 + step < H && BandWhite(x0, y1 + 1, x1, y1 + step, whiteFrac)) { ty1 = y1 + step; grew = true; }
            if (x0 >= step && BandWhite(x0 - step, ty0, x0 - 1, ty1, whiteFrac)) { tx0 = x0 - step; grew = true; }
            if (x1 + step < W && BandWhite(x1 + 1, ty0, x1 + step, ty1, whiteFrac)) { tx1 = x1 + step; grew = true; }
            if (!grew) break;
            x0 = tx0; y0 = ty0; x1 = tx1; y1 = ty1;
            x0s = x0; y0s = y0; x1s = x1; y1s = y1;
        }

        if (x1 - x0 < 6 || y1 - y0 < 6) return new Result();
        bool atEdge = (x0 <= 0 || y0 <= 0 || x1 >= W - 1 || y1 >= H - 1);
        if (x0 <= 0) x0 = x0s;
        if (y0 <= 0) y0 = y0s;
        if (x1 >= W - 1) x1 = x1s;
        if (y1 >= H - 1) y1 = y1s;

        double shortSide = Math.Min(x1 - x0 + 1, y1 - y0 + 1);
        double padPx = Math.Max(2.0, padFraction * shortSide);
        Result res = new Result();
        res.ok = true;
        res.leak = atEdge;
        res.area = (long)(x1 - x0) * (long)(y1 - y0);
        res.bbox = new double[] { x0 / scale, y0 / scale, (x1 + 1) / scale, (y1 + 1) / scale };
        res.center = new double[] { (x0 + x1 + 1) / 2.0 / scale, (y0 + y1 + 1) / 2.0 / scale };
        res.radius = shortSide / 2.0 / scale;
        res.fitRect = new double[] { (x0 + padPx) / scale, (y0 + padPx) / scale,
                                     (x1 + 1 - padPx) / scale, (y1 + 1 - padPx) / scale };
        res.poly = new List<double[]>();
        res.poly.Add(new double[] { res.fitRect[0], res.fitRect[1] });
        res.poly.Add(new double[] { res.fitRect[2], res.fitRect[1] });
        res.poly.Add(new double[] { res.fitRect[2], res.fitRect[3] });
        res.poly.Add(new double[] { res.fitRect[0], res.fitRect[3] });
        long tot = 0, ink = 0;
        int fx0 = Math.Max(0, (int)(x0 + padPx)), fy0 = Math.Max(0, (int)(y0 + padPx));
        int fx1 = Math.Min(W, (int)(x1 + 1 - padPx)), fy1 = Math.Min(H, (int)(y1 + 1 - padPx));
        for (int yy = fy0; yy < fy1; yy++)
            for (int xx = fx0; xx < fx1; xx++) { tot++; if (mask[yy * W + xx] == 0) ink++; }
        res.fitInk = tot > 0 ? (double)ink / tot : 0;
        res.dbg = "box edge=" + (atEdge ? 1 : 0) + " x" + N((double)(x1 - x0 + 1) / Math.Max(1.0, r.x2 - r.x1));
        return res;
    }

    /* a band is paper only when (almost) every pixel of it is paper */
    static bool BandWhite(int x0, int y0, int x1, int y1, double frac)
    {
        long tot = 0, wh = 0;
        for (int y = y0; y <= y1; y++)
        {
            if (y < 0 || y >= H) { tot++; continue; }
            int row = y * W;
            for (int x = x0; x <= x1; x++)
            {
                if (x < 0 || x >= W) { tot++; continue; }
                tot++;
                if (mask[row + x] == 1) wh++;
            }
        }
        return tot > 0 && (double)wh / tot >= frac;
    }
    static bool Metricise(Result res, bool[] lobe, int lw, int lh, int x0, int y0,
                          double padFraction, double scale)
    {
        float[] dl = Chamfer(lobe, lw, lh);

        int bx0 = lw, by0 = lh, bx1 = -1, by1 = -1;
        for (int y = 0; y < lh; y++)
            for (int x = 0; x < lw; x++)
                if (lobe[y * lw + x])
                {
                    if (x < bx0) bx0 = x;
                    if (y < by0) by0 = y;
                    if (x > bx1) bx1 = x;
                    if (y > by1) by1 = y;
                }
        if (bx1 < 0) return false;

        double bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
        double shortSide = Math.Min(bw, bh);
        double r14 = Math.Max(4.0, 0.14 * shortSide);
        double padPx = Math.Max(2.0, padFraction * shortSide);

        float maxL = 0;
        int maxI = 0;
        for (int i = 0; i < dl.Length; i++) if (dl[i] > maxL) { maxL = dl[i]; maxI = i; }

        double sx = 0, sy = 0; long nBody = 0;
        for (int i = 0; i < dl.Length; i++)
            if (dl[i] >= r14) { sx += i % lw; sy += i / lw; nBody++; }

        double cx, cy;
        if (nBody > 0) { cx = sx / nBody; cy = sy / nBody; }
        else { cx = maxI % lw; cy = maxI / lw; }

        int icx = (int)Math.Round(cx), icy = (int)Math.Round(cy);
        if (icx < 0 || icy < 0 || icx >= lw || icy >= lh || dl[icy * lw + icx] < padPx)
        {
            cx = maxI % lw; cy = maxI / lw;
            icx = (int)Math.Round(cx); icy = (int)Math.Round(cy);
        }

        res.center[0] = (x0 + cx) / scale;
        res.center[1] = (y0 + cy) / scale;
        res.radius = maxL / scale;
        res.bbox[0] = (x0 + bx0) / scale;
        res.bbox[1] = (y0 + by0) / scale;
        res.bbox[2] = (x0 + bx1 + 1) / scale;
        res.bbox[3] = (y0 + by1 + 1) / scale;

        double maxHW = Math.Min(cx, lw - 1 - cx), maxHH = Math.Min(cy, lh - 1 - cy);
        double seedScale = BinaryScale(dl, lw, lh, cx, cy, maxHW, maxHH, padPx);
        double halfW = maxHW * seedScale, halfH = maxHH * seedScale;

        double lo = seedScale, hi = 1.0, bestW = seedScale;
        for (int it = 0; it < 14; it++)
        {
            double mid = (lo + hi) / 2;
            if (RectInside(dl, lw, lh, cx, cy, maxHW * mid, halfH, padPx)) { bestW = mid; lo = mid; } else hi = mid;
        }
        halfW = maxHW * bestW;
        lo = seedScale; hi = 1.0; double bestH = seedScale;
        for (int it = 0; it < 14; it++)
        {
            double mid = (lo + hi) / 2;
            if (RectInside(dl, lw, lh, cx, cy, halfW, maxHH * mid, padPx)) { bestH = mid; lo = mid; } else hi = mid;
        }
        halfH = maxHH * bestH;

        res.fitRect[0] = (x0 + cx - halfW) / scale;
        res.fitRect[1] = (y0 + cy - halfH) / scale;
        res.fitRect[2] = (x0 + cx + halfW) / scale;
        res.fitRect[3] = (y0 + cy + halfH) / scale;

        int PN = 120;
        int open = 0;
        double rayLimit = maxL * 1.8 + 10;
        double stepRad = 2 * Math.PI / PN;
        double maxR = Math.Sqrt(bw * bw + bh * bh) + 2;
        for (int k = 0; k < PN; k++)
        {
            double ang = k * stepRad;
            double dx = Math.Cos(ang), dy = Math.Sin(ang);
            double lastR = 0;
            for (double rr = 1; rr < maxR; rr += 1.0)
            {
                int px = (int)Math.Round(cx + dx * rr), py = (int)Math.Round(cy + dy * rr);
                if (px < 0 || py < 0 || px >= lw || py >= lh) break;
                if (dl[py * lw + px] < padPx) break;
                lastR = rr;
            }
            if (lastR > rayLimit) open++;
            res.poly.Add(new double[] { (x0 + cx + dx * lastR) / scale, (y0 + cy + dy * lastR) / scale });
        }
        res.openRays = open;
        for (int pass = 0; pass < 2; pass++)
        {
            List<double[]> sm = new List<double[]>();
            for (int k = 0; k < res.poly.Count; k++)
            {
                double[] a = res.poly[(k + res.poly.Count - 1) % res.poly.Count];
                double[] b = res.poly[k];
                double[] e = res.poly[(k + 1) % res.poly.Count];
                sm.Add(new double[] { (a[0] + 2 * b[0] + e[0]) / 4, (a[1] + 2 * b[1] + e[1]) / 4 });
            }
            res.poly = sm;
        }
        return true;
    }

    static void WriteBubbleDump(string imgPath, string outPath, List<Result> bubbles)
    {
        using (Bitmap src = Load24(imgPath))
        {
            Bitmap dst = new Bitmap(src.Width, src.Height, PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(dst))
            {
                g.DrawImage(src, 0, 0);
                using (Pen green = new Pen(Color.FromArgb(0, 170, 0), 2))
                using (Pen magenta = new Pen(Color.Magenta, 1))
                using (Pen red = new Pen(Color.Red, 2))
                {
                    foreach (Result r in bubbles)
                    {
                        if (r.poly.Count > 2)
                        {
                            PointF[] pts = new PointF[r.poly.Count];
                            for (int i = 0; i < r.poly.Count; i++)
                                pts[i] = new PointF((float)(r.poly[i][0] * s_scale), (float)(r.poly[i][1] * s_scale));
                            g.DrawPolygon(green, pts);
                        }
                        g.DrawRectangle(magenta, (float)(r.fitRect[0] * s_scale), (float)(r.fitRect[1] * s_scale),
                            (float)((r.fitRect[2] - r.fitRect[0]) * s_scale), (float)((r.fitRect[3] - r.fitRect[1]) * s_scale));
                        float px = (float)(r.center[0] * s_scale), py = (float)(r.center[1] * s_scale);
                        g.DrawLine(red, px - 8, py, px + 8, py);
                        g.DrawLine(red, px, py - 8, px, py + 8);
                    }
                }
            }
            dst.Save(outPath, ImageFormat.Png);
        }
    }

    // ------------------------------------------------------------------ json

    static string Arr(double[] a)
    {
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < a.Length; i++)
        {
            if (i > 0) b.Append(',');
            b.Append(N(a[i]));
        }
        return b.Append(']').ToString();
    }

    static string ToJson(Result r)
    {
        StringBuilder b = new StringBuilder();
        b.Append("{\"ok\":").Append(r.ok ? "true" : "false");
        b.Append(",\"leak\":").Append(r.leak ? "true" : "false");
        b.Append(",\"area\":").Append(r.area.ToString(CultureInfo.InvariantCulture));
        b.Append(",\"center\":").Append(Arr(r.center));
        b.Append(",\"radius\":").Append(N(r.radius));
        b.Append(",\"bbox\":").Append(Arr(r.bbox));
        b.Append(",\"fitRect\":").Append(Arr(r.fitRect));
        b.Append(",\"fitInk\":").Append(N(r.fitInk));
        b.Append(",\"dbg\":\"").Append(r.dbg.Replace("\\", "\\\\").Replace("\"", "\\\"")).Append('"');
        b.Append(",\"poly\":[");
        for (int i = 0; i < r.poly.Count; i++)
        {
            if (i > 0) b.Append(',');
            b.Append(Arr(r.poly[i]));
        }
        b.Append("]}");
        return b.ToString();
    }

    static string N(double v) { return v.ToString("0.###", CultureInfo.InvariantCulture); }
}
