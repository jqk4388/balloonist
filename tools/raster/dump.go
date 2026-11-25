package main

import (
	"image"
	"image/color"
	"image/draw"
	"math"
)

var s_scale = 1.0

// writeBubbleDump paints the geometry the analyser found onto a copy of the
// page, so a bad run can be looked at directly. Colours match the .NET build:
// outline green 2px, safe box magenta 1px, centre cross red 2px.
func writeBubbleDump(imgPath, outPath string, bubbles []Result) error {
	im, err := decodeImage(imgPath)
	if err != nil {
		return err
	}
	b := im.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), im, b.Min, draw.Src)

	green := color.RGBA{0, 170, 0, 255}
	magenta := color.RGBA{255, 0, 255, 255}
	red := color.RGBA{255, 0, 0, 255}

	plot := func(x, y, r int, c color.RGBA) {
		for dy := -r; dy <= r; dy++ {
			for dx := -r; dx <= r; dx++ {
				px, py := x+dx, y+dy
				if px < 0 || py < 0 || px >= dst.Bounds().Dx() || py >= dst.Bounds().Dy() {
					continue
				}
				dst.SetRGBA(px, py, c)
			}
		}
	}
	line := func(x0, y0, x1, y1 float64, width int, c color.RGBA) {
		dx, dy := x1-x0, y1-y0
		steps := int(math.Max(math.Abs(dx), math.Abs(dy)))
		if steps < 1 {
			steps = 1
		}
		for i := 0; i <= steps; i++ {
			t := float64(i) / float64(steps)
			plot(int(math.RoundToEven(x0+dx*t)), int(math.RoundToEven(y0+dy*t)), width/2, c)
		}
	}

	for _, r := range bubbles {
		if len(r.poly) > 2 {
			for i := 0; i < len(r.poly); i++ {
				a := r.poly[i]
				e := r.poly[(i+1)%len(r.poly)]
				line(a[0]*s_scale, a[1]*s_scale, e[0]*s_scale, e[1]*s_scale, 2, green)
			}
		}
		x0, y0 := r.fitRect[0]*s_scale, r.fitRect[1]*s_scale
		x1, y1 := r.fitRect[2]*s_scale, r.fitRect[3]*s_scale
		line(x0, y0, x1, y0, 1, magenta)
		line(x1, y0, x1, y1, 1, magenta)
		line(x1, y1, x0, y1, 1, magenta)
		line(x0, y1, x0, y0, 1, magenta)

		px, py := r.center[0]*s_scale, r.center[1]*s_scale
		line(px-8, py, px+8, py, 2, red)
		line(px, py-8, px, py+8, 2, red)
	}
	return savePNG(outPath, dst)
}
