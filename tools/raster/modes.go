package main

import (
	"math"
	"strconv"
)

// ---------------------------------------------------------------- blobs

/* bright regions enclosed by ink: the workhorse for already-lettered art.
   Page margin is bright too, but it either spans the page or fills a large
   rectangle and is rejected by the compact-edge rule below. A balloon cut
   off by the page trim loses part of its outline and touches the border,
   so compact border regions are accepted and flagged with leak=true.
   Glyphs inside a bubble are holes and get filled back in before the
   metrics are taken. */
func Blobs(padFraction, scale, minSidePx, minAreaPx, maxAspect, maxAreaPx, minFill float64, lightThr, dilate int) []Result {
	ink := make([]bool, W*H)
	for i := 0; i < W*H; i++ {
		ink[i] = int(lumv[i]) < lightThr
	}
	for it := 0; it < dilate; it++ {
		Dilate(ink)
	}

	lab := make([]int, W*H)
	for i := 0; i < len(lab); i++ {
		lab[i] = -1
	}
	queue := make([]int, W*H)
	var list []Comp
	for sy0 := 0; sy0 < H; sy0++ {
		for sx0 := 0; sx0 < W; sx0++ {
			idx := sy0*W + sx0
			if ink[idx] || lab[idx] >= 0 {
				continue
			}
			c := Comp{id: len(list), minX: math.MaxInt32, minY: math.MaxInt32, maxX: -1, maxY: -1}
			head, tail := 0, 0
			queue[tail] = idx
			tail++
			lab[idx] = c.id
			for head < tail {
				p := queue[head]
				head++
				x, y := p%W, p/W
				c.area++
				c.sumX += int64(x)
				c.sumY += int64(y)
				if x < c.minX {
					c.minX = x
				}
				if y < c.minY {
					c.minY = y
				}
				if x > c.maxX {
					c.maxX = x
				}
				if y > c.maxY {
					c.maxY = y
				}
				if x == 0 || y == 0 || x == W-1 || y == H-1 {
					c.touchesBorder = true
				}
				if x > 0 {
					q := p - 1
					if !ink[q] && lab[q] < 0 {
						lab[q] = c.id
						queue[tail] = q
						tail++
					}
				}
				if x < W-1 {
					q := p + 1
					if !ink[q] && lab[q] < 0 {
						lab[q] = c.id
						queue[tail] = q
						tail++
					}
				}
				if y > 0 {
					q := p - W
					if !ink[q] && lab[q] < 0 {
						lab[q] = c.id
						queue[tail] = q
						tail++
					}
				}
				if y < H-1 {
					q := p + W
					if !ink[q] && lab[q] < 0 {
						lab[q] = c.id
						queue[tail] = q
						tail++
					}
				}
			}
			list = append(list, c)
		}
	}

	var found []Result
	for k := 0; k < len(list); k++ {
		c := list[k]
		if float64(c.area) < minAreaPx || float64(c.area) > maxAreaPx {
			continue
		}
		bw := c.maxX - c.minX + 1
		bh := c.maxY - c.minY + 1
		edge := c.touchesBorder
		if edge {
			/* A balloon cut by the page trim is still a balloon: its white
			   interior ends at the image border, so touchesBorder is true.
			   The page margin is paper as well, but it either spans the page
			   or fills a large rectangle. Only compact regions are let
			   through, so the margin cannot become a bubble. */
			if float64(bw) > 0.50*float64(W) || float64(bh) > 0.50*float64(H) {
				continue
			}
		}
		if float64(bw) < minSidePx || float64(bh) < minSidePx {
			continue
		}
		if math.Max(float64(bw), float64(bh)) > maxAspect*math.Min(float64(bw), float64(bh)) {
			continue
		}
		fill := float64(c.area) / (float64(bw) * float64(bh))
		if fill < minFill {
			continue
		}

		x0 := maxInt(0, c.minX-2)
		y0 := maxInt(0, c.minY-2)
		x1 := minInt(W-1, c.maxX+2)
		y1 := minInt(H-1, c.maxY+2)
		lw, lh := x1-x0+1, y1-y0+1
		region := make([]bool, lw*lh)
		for y := 0; y < lh; y++ {
			for x := 0; x < lw; x++ {
				region[y*lw+x] = lab[(y0+y)*W+(x0+x)] == c.id
			}
		}
		FillHoles(region, lw, lh)

		var res Result
		if !Metricise(&res, region, lw, lh, x0, y0, padFraction, scale) {
			continue
		}

		fx0 := maxInt(0, int(math.RoundToEven(res.fitRect[0]*scale)))
		fy0 := maxInt(0, int(math.RoundToEven(res.fitRect[1]*scale)))
		fx1 := minInt(W, int(math.RoundToEven(res.fitRect[2]*scale)))
		fy1 := minInt(H, int(math.RoundToEven(res.fitRect[3]*scale)))
		tot, inked := int64(0), int64(0)
		for yy := fy0; yy < fy1; yy++ {
			for xx := fx0; xx < fx1; xx++ {
				tot++
				if ink[yy*W+xx] {
					inked++
				}
			}
		}
		if tot > 0 {
			res.fitInk = float64(inked) / float64(tot)
		}
		res.ok = true
		res.leak = edge
		res.area = int64(c.area)
		res.openRays = 0
		res.dbg = "blob fill=" + N(fill)
		if edge {
			res.dbg += " edge=1"
		}
		found = append(found, res)
	}
	return found
}

// --------------------------------------------------------------- bubbles

func Bubbles(padFraction, hFrac, scale, minSidePx, minAreaPx, maxAspect, maxAreaPx, minRingInk, minRectFill float64) []Result {
	var found []Result
	for cid := 1; cid <= len(comps); cid++ {
		c := &comps[cid-1]
		if float64(c.area) < minAreaPx {
			continue
		}
		/* the page margin is paper too - it is the one blob that is not a
		   bubble, and skipping it early keeps the pass fast */
		if c.touchesBorder && float64(c.area) > 0.2*float64(W)*float64(H) {
			continue
		}

		x0 := maxInt(0, c.minX-2)
		y0 := maxInt(0, c.minY-2)
		x1 := minInt(W-1, c.maxX+2)
		y1 := minInt(H-1, c.maxY+2)
		lw, lh := x1-x0+1, y1-y0+1

		inside := make([]bool, lw*lh)
		for y := 0; y < lh; y++ {
			for x := 0; x < lw; x++ {
				inside[y*lw+x] = labels[(y0+y)*W+(x0+x)] == cid
			}
		}

		outside := make([]bool, lw*lh)
		stack := make([]int, lw*lh)
		sp := 0
		for x := 0; x < lw; x++ {
			Seed(outside, stack, &sp, inside, lw, lh, x, 0)
			Seed(outside, stack, &sp, inside, lw, lh, x, lh-1)
		}
		for y := 0; y < lh; y++ {
			Seed(outside, stack, &sp, inside, lw, lh, 0, y)
			Seed(outside, stack, &sp, inside, lw, lh, lw-1, y)
		}
		for sp > 0 {
			sp--
			p := stack[sp]
			x, y := p%lw, p/lw
			Seed(outside, stack, &sp, inside, lw, lh, x-1, y)
			Seed(outside, stack, &sp, inside, lw, lh, x+1, y)
			Seed(outside, stack, &sp, inside, lw, lh, x, y-1)
			Seed(outside, stack, &sp, inside, lw, lh, x, y+1)
		}
		for i := 0; i < len(inside); i++ {
			if !inside[i] && !outside[i] {
				inside[i] = true
			}
		}

		d := Chamfer(inside, lw, lh)
		maxD := float32(0)
		for i := 0; i < len(d); i++ {
			if d[i] > maxD {
				maxD = d[i]
			}
		}
		if maxD <= 0 {
			continue
		}

		reps, cMax := HMaximaSeeds(d, inside, lw, lh, float32(hFrac*float64(maxD)))
		coreCount := len(reps)
		if coreCount == 0 {
			continue
		}

		ws, saddles := Watershed(d, inside, lw, lh, reps)
		uf := NewUnionFind(coreCount)
		MergeBasins(uf, saddles, cMax, 0.99)

		rootIdx := make([]int, coreCount)
		for k := 0; k < coreCount; k++ {
			rootIdx[k] = -1
		}
		nRoots := 0
		for k := 0; k < coreCount; k++ {
			r := uf.Find(k)
			if rootIdx[r] < 0 {
				rootIdx[r] = nRoots
				nRoots++
			}
		}

		/* pass 1: area, so hopeless basins never get a mask allocated */
		lobeAreas := make([]int64, nRoots)
		for i := 0; i < len(ws); i++ {
			if !inside[i] || ws[i] < 0 {
				continue
			}
			lobeAreas[rootIdx[uf.Find(ws[i])]]++
		}
		keep := make([]bool, nRoots)
		for k := 0; k < nRoots; k++ {
			keep[k] = float64(lobeAreas[k]) >= minAreaPx && float64(lobeAreas[k]) <= maxAreaPx
		}

		/* pass 2: one mask per surviving basin */
		lobes := make([][]bool, nRoots)
		for k := 0; k < nRoots; k++ {
			if keep[k] {
				lobes[k] = make([]bool, lw*lh)
			}
		}
		for i := 0; i < len(ws); i++ {
			if !inside[i] || ws[i] < 0 {
				continue
			}
			idx := rootIdx[uf.Find(ws[i])]
			if keep[idx] {
				lobes[idx][i] = true
			}
		}

		for k := 0; k < nRoots; k++ {
			if !keep[k] {
				continue
			}
			var r Result
			if !Metricise(&r, lobes[k], lw, lh, x0, y0, padFraction, scale) {
				continue
			}

			bwPt := r.bbox[2] - r.bbox[0]
			bhPt := r.bbox[3] - r.bbox[1]
			shortPx := math.Min(bwPt, bhPt) * scale
			longPx := math.Max(bwPt, bhPt) * scale
			if shortPx < minSidePx {
				continue
			}
			if longPx/math.Max(1.0, shortPx) > maxAspect {
				continue
			}

			fill := float64(lobeAreas[k]) / math.Max(1.0, (bwPt*scale)*(bhPt*scale))
			if fill < 0.55 {
				continue
			}
			/* a painted-over bubble is a clean white RECTANGLE: keep only
			   basins that fill their bounding box */
			if minRectFill > 0 && fill < minRectFill {
				continue
			}
			/* a bubble is closed by its ink outline; rays that run away
			   mean the paper leaks into the panel background */
			if r.openRays > 8 {
				continue
			}

			/* ...and the shell just outside the body must actually meet ink:
			   a bubble is drawn with an outline, white pockets and panel
			   gutters are paper on every side and fail here. */
			inv := make([]bool, lw*lh)
			for i := 0; i < len(inv); i++ {
				inval := !lobes[k][i]
				inv[i] = inval
			}
			dOut := Chamfer(inv, lw, lh)
			ringPx, inkPx := int64(0), int64(0)
			for i := 0; i < len(dOut); i++ {
				if !inv[i] || dOut[i] <= 0 || dOut[i] > 28 {
					continue
				}
				ringPx++
				gx := x0 + (i % lw)
				gy := y0 + (i / lw)
				if mask[gy*W+gx] == 0 {
					inkPx++
				}
			}
			inkRatio := 0.0
			if ringPx > 0 {
				inkRatio = float64(inkPx) / float64(ringPx)
			}
			if inkRatio < minRingInk {
				continue
			}

			/* ink inside the safe box: a lettered bubble carries strokes,
			   a white cheek or paper pocket carries none */
			fx0 := int(math.RoundToEven(r.fitRect[0] * scale))
			fy0 := int(math.RoundToEven(r.fitRect[1] * scale))
			fx1 := int(math.RoundToEven(r.fitRect[2] * scale))
			fy1 := int(math.RoundToEven(r.fitRect[3] * scale))
			if fx0 < 0 {
				fx0 = 0
			}
			if fy0 < 0 {
				fy0 = 0
			}
			if fx1 > W {
				fx1 = W
			}
			if fy1 > H {
				fy1 = H
			}
			tot, ink := int64(0), int64(0)
			for yy := fy0; yy < fy1; yy++ {
				for xx := fx0; xx < fx1; xx++ {
					tot++
					if mask[yy*W+xx] == 0 {
						ink++
					}
				}
			}
			if tot > 0 {
				r.fitInk = float64(ink) / float64(tot)
			}

			r.area = lobeAreas[k]
			r.ok = true
			r.dbg = "basin=" + i64s(r.area) + " fill=" + N(fill) + " aspect=" + N(longPx/math.Max(1.0, shortPx)) +
				" open=" + i64s(int64(r.openRays))
			found = append(found, r)
		}
	}
	return found
}

// ------------------------------------------------------------ local frames

/* Frame mode: the TypeR magic-wand move. Flood the paper from the frame
   centre inside a window around the frame. The connected paper region is
   the bubble the frame sits in; a tail is cut off by the same 14% rule,
   the centroid of the body becomes the target. Cheap: work stays local. */
func DetectLocal(r Rect, padFraction, hFrac, scale float64) Result {
	var res Result
	res.setEmpty()

	wPt := r.x2 - r.x1
	hPt := r.y2 - r.y1
	margin := math.Max(24.0, 0.6*math.Max(wPt, hPt)) * scale

	for attempt := 0; attempt < 3; attempt++ {
		wx0 := maxInt(0, int(math.Floor(r.x1*scale-margin)))
		wy0 := maxInt(0, int(math.Floor(r.y1*scale-margin)))
		wx1 := minInt(W, int(math.Ceil(r.x2*scale+margin)))
		wy1 := minInt(H, int(math.Ceil(r.y2*scale+margin)))
		lw, lh := wx1-wx0, wy1-wy0
		if lw < 8 || lh < 8 {
			return res
		}

		sx := int(math.RoundToEven((r.x1 + r.x2) / 2 * scale))
		sy := int(math.RoundToEven((r.y1 + r.y2) / 2 * scale))
		region, ok := FloodWhite(wx0, wy0, lw, lh, sx, sy)
		if !ok {
			margin *= 1.7
			continue
		}

		onPageEdge := wx0 <= 0 && wy0 <= 0 && wx1 >= W && wy1 >= H
		if !onPageEdge && RegionTouchesBorder(region, lw, lh) {
			margin *= 1.7
			continue
		}

		FillHoles(region, lw, lh)
		res = Result{}
		res.setEmpty()
		if !Metricise(&res, region, lw, lh, wx0, wy0, padFraction, scale) {
			res.ok = false
			return res
		}

		/* ink inside the safe box, same measure the survey uses */
		fx0 := maxInt(0, int(math.RoundToEven(res.fitRect[0]*scale)))
		fy0 := maxInt(0, int(math.RoundToEven(res.fitRect[1]*scale)))
		fx1 := minInt(W, int(math.RoundToEven(res.fitRect[2]*scale)))
		fy1 := minInt(H, int(math.RoundToEven(res.fitRect[3]*scale)))
		tot, ink := int64(0), int64(0)
		for yy := fy0; yy < fy1; yy++ {
			for xx := fx0; xx < fx1; xx++ {
				tot++
				if mask[yy*W+xx] == 0 {
					ink++
				}
			}
		}
		if tot > 0 {
			res.fitInk = float64(ink) / float64(tot)
		}
		res.ok = true
		res.area = int64(Count(region))
		res.dbg = "local win=" + i64s(int64(lw)) + "x" + i64s(int64(lh)) + " band=" +
			N(float64(res.area)/math.Max(1.0, float64(lw*lh)))
		return res
	}
	res = Result{}
	res.setEmpty()
	return res
}

/* 4-connected flood of white pixels inside the window, seeded at the frame
   centre (or the nearest white pixel when the centre itself is inked). */
func FloodWhite(wx0, wy0, lw, lh, sx, sy int) ([]bool, bool) {
	lx := sx - wx0
	ly := sy - wy0
	if lx < 0 || ly < 0 || lx >= lw || ly >= lh {
		return nil, false
	}
	if sx < 0 || sy < 0 || sx >= W || sy >= H {
		return nil, false
	}
	if mask[sy*W+sx] == 0 {
		found := false
		for rad := 1; rad <= 24 && !found; rad++ {
			for dy := -rad; dy <= rad && !found; dy++ {
				for dx := -rad; dx <= rad && !found; dx++ {
					tx, ty := lx+dx, ly+dy
					if !InWin(tx, ty, lw, lh) {
						continue
					}
					if mask[(wy0+ty)*W+(wx0+tx)] != 1 {
						continue
					}
					lx, ly = tx, ty
					found = true
				}
			}
		}
		if !found {
			return nil, false
		}
	}

	done := make([]bool, lw*lh)
	q := make([]int, lw*lh)
	head, tail := 0, 0
	start := ly*lw + lx
	done[start] = true
	q[tail] = start
	tail++
	for head < tail {
		cur := q[head]
		head++
		cx, cy := cur%lw, cur/lw
		if cx > 0 {
			tryPush(q, done, &tail, cx-1, cy, lw, wx0, wy0)
		}
		if cx < lw-1 {
			tryPush(q, done, &tail, cx+1, cy, lw, wx0, wy0)
		}
		if cy > 0 {
			tryPush(q, done, &tail, cx, cy-1, lw, wx0, wy0)
		}
		if cy < lh-1 {
			tryPush(q, done, &tail, cx, cy+1, lw, wx0, wy0)
		}
	}
	region := make([]bool, lw*lh)
	for i := 0; i < tail; i++ {
		region[q[i]] = true
	}
	return region, true
}

func tryPush(q []int, done []bool, tail *int, nx, ny, lw, wx0, wy0 int) {
	idx := ny*lw + nx
	if done[idx] {
		return
	}
	if mask[(wy0+ny)*W+(wx0+nx)] != 1 {
		return
	}
	done[idx] = true
	q[*tail] = idx
	*tail++
}

// ------------------------------------------------------------------ box

/* Box mode: the bubble is a painted white rectangle (cleaned/redrawn
   bubbles have no outline left). Grow the frame's rectangle outwards
   while each new band stays white, then centre on that box. The right
   model for LP/retouch documents, where the ink-ring test can never
   fire because the outline was painted over. */
func DetectBox(r Rect, padFraction, scale, whiteFrac float64) Result {
	var res Result
	res.setEmpty()

	x0 := maxInt(0, int(math.Floor(r.x1)))
	y0 := maxInt(0, int(math.Floor(r.y1)))
	x1 := minInt(W-1, int(math.Ceil(r.x2)))
	y1 := minInt(H-1, int(math.Ceil(r.y2)))
	if x1-x0 < 3 || y1-y0 < 3 {
		return res
	}

	const step = 2
	x0s, y0s, x1s, y1s := x0, y0, x1, y1
	for guard := 0; guard < 4096; guard++ {
		tx0, ty0, tx1, ty1 := x0, y0, x1, y1
		grew := false
		if y0 >= step && BandWhite(x0, y0-step, x1, y0-1, whiteFrac) {
			ty0 = y0 - step
			grew = true
		}
		if y1+step < H && BandWhite(x0, y1+1, x1, y1+step, whiteFrac) {
			ty1 = y1 + step
			grew = true
		}
		if x0 >= step && BandWhite(x0-step, ty0, x0-1, ty1, whiteFrac) {
			tx0 = x0 - step
			grew = true
		}
		if x1+step < W && BandWhite(x1+1, ty0, x1+step, ty1, whiteFrac) {
			tx1 = x1 + step
			grew = true
		}
		if !grew {
			break
		}
		x0, y0, x1, y1 = tx0, ty0, tx1, ty1
		x0s, y0s, x1s, y1s = x0, y0, x1, y1
	}

	if x1-x0 < 6 || y1-y0 < 6 {
		return res
	}
	atEdge := x0 <= 0 || y0 <= 0 || x1 >= W-1 || y1 >= H-1
	if x0 <= 0 {
		x0 = x0s
	}
	if y0 <= 0 {
		y0 = y0s
	}
	if x1 >= W-1 {
		x1 = x1s
	}
	if y1 >= H-1 {
		y1 = y1s
	}

	shortSide := math.Min(float64(x1-x0+1), float64(y1-y0+1))
	padPx := math.Max(2.0, padFraction*shortSide)
	res.ok = true
	res.leak = atEdge
	res.area = int64(x1-x0) * int64(y1-y0)
	res.bbox = [4]float64{float64(x0) / scale, float64(y0) / scale, float64(x1+1) / scale, float64(y1+1) / scale}
	res.center = [2]float64{float64(x0+x1+1) / 2.0 / scale, float64(y0+y1+1) / 2.0 / scale}
	res.radius = shortSide / 2.0 / scale
	res.fitRect = [4]float64{
		(float64(x0) + padPx) / scale,
		(float64(y0) + padPx) / scale,
		(float64(x1) + 1 - padPx) / scale,
		(float64(y1) + 1 - padPx) / scale,
	}
	res.poly = [][2]float64{
		{res.fitRect[0], res.fitRect[1]},
		{res.fitRect[2], res.fitRect[1]},
		{res.fitRect[2], res.fitRect[3]},
		{res.fitRect[0], res.fitRect[3]},
	}
	tot, ink := int64(0), int64(0)
	fx0 := maxInt(0, int(float64(x0)+padPx))
	fy0 := maxInt(0, int(float64(y0)+padPx))
	fx1 := minInt(W, int(float64(x1)+1-padPx))
	fy1 := minInt(H, int(float64(y1)+1-padPx))
	for yy := fy0; yy < fy1; yy++ {
		for xx := fx0; xx < fx1; xx++ {
			tot++
			if mask[yy*W+xx] == 0 {
				ink++
			}
		}
	}
	if tot > 0 {
		res.fitInk = float64(ink) / float64(tot)
	}
	edge := 0
	if atEdge {
		edge = 1
	}
	res.dbg = "box edge=" + i64s(int64(edge)) + " x" + N(float64(x1-x0+1)/math.Max(1.0, r.x2-r.x1))
	return res
}

/* a band is paper only when (almost) every pixel of it is paper */
func BandWhite(x0, y0, x1, y1 int, frac float64) bool {
	tot, wh := int64(0), int64(0)
	for y := y0; y <= y1; y++ {
		if y < 0 || y >= H {
			tot++
			continue
		}
		row := y * W
		for x := x0; x <= x1; x++ {
			if x < 0 || x >= W {
				tot++
				continue
			}
			tot++
			if mask[row+x] == 1 {
				wh++
			}
		}
	}
	return tot > 0 && float64(wh)/float64(tot) >= frac
}

// --------------------------------------------------------------- helpers

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func i64s(v int64) string { return strconv.FormatInt(v, 10) }
