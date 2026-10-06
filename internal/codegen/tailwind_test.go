package codegen

import (
	"reflect"
	"testing"
)

// CSS property -> Tailwind class table: one row per mapping rule, so a
// renamed utility or a new case shows up here.
func TestTailwindFor(t *testing.T) {
	cases := []struct {
		name string
		prop Prop
		want []string
	}{
		{"position absolute", Prop{"position", "absolute"}, []string{"absolute"}},
		{"position relative", Prop{"position", "relative"}, []string{"relative"}},
		{"left px", Prop{"left", "12px"}, []string{"left-[12px]"}},
		{"left zero", Prop{"left", "0"}, []string{"left-0"}},
		{"top negative", Prop{"top", "-20px"}, []string{"top-[-20px]"}},
		{"width px", Prop{"width", "320px"}, []string{"w-[320px]"}},
		{"width hug", Prop{"width", "fit-content"}, []string{"w-fit"}},
		{"height px", Prop{"height", "48px"}, []string{"h-[48px]"}},
		{"height zero", Prop{"height", "0"}, []string{"h-0"}},
		{"display flex", Prop{"display", "flex"}, []string{"flex"}},
		{"column", Prop{"flex-direction", "column"}, []string{"flex-col"}},
		{"justify start", Prop{"justify-content", "flex-start"}, []string{"justify-start"}},
		{"justify center", Prop{"justify-content", "center"}, []string{"justify-center"}},
		{"justify end", Prop{"justify-content", "flex-end"}, []string{"justify-end"}},
		{"justify between", Prop{"justify-content", "space-between"}, []string{"justify-between"}},
		{"items start", Prop{"align-items", "flex-start"}, []string{"items-start"}},
		{"items end", Prop{"align-items", "flex-end"}, []string{"items-end"}},
		{"gap", Prop{"gap", "8px"}, []string{"gap-[8px]"}},
		{"padding uniform", Prop{"padding", "16px"}, []string{"p-[16px]"}},
		{"padding y x", Prop{"padding", "8px 16px"}, []string{"py-[8px]", "px-[16px]"}},
		{"padding four", Prop{"padding", "1px 2px 3px 4px"}, []string{"pt-[1px]", "pr-[2px]", "pb-[3px]", "pl-[4px]"}},
		{"padding with zero", Prop{"padding", "0 20px"}, []string{"py-0", "px-[20px]"}},
		{"shrink", Prop{"flex-shrink", "0"}, []string{"shrink-0"}},
		{"overflow hidden", Prop{"overflow", "hidden"}, []string{"overflow-hidden"}},
		{"overflow visible", Prop{"overflow", "visible"}, []string{"overflow-visible"}},
		{"rotation", Prop{"transform", "rotate(30deg)"}, []string{"rotate-[30deg]"}},
		{"negative rotation", Prop{"transform", "rotate(-12.5deg)"}, []string{"rotate-[-12.5deg]"}},
		{"radius", Prop{"border-radius", "12px"}, []string{"rounded-[12px]"}},
		{"ellipse", Prop{"border-radius", "50%"}, []string{"rounded-[50%]"}},
		{"solid background", Prop{"background-color", "#fff"}, []string{"bg-[#fff]"}},
		{"rgba background", Prop{"background-color", "rgba(0,0,0,0.5)"}, []string{"bg-[rgba(0,0,0,0.5)]"}},
		{"linear gradient", Prop{"background-image", "linear-gradient(90deg,#fff 0%,#000 100%)"}, []string{"bg-[linear-gradient(90deg,#fff_0%,#000_100%)]"}},
		{"radial gradient", Prop{"background-image", "radial-gradient(circle 50px at 10px 10px,#fff 0%,#000 100%)"}, []string{"bg-[radial-gradient(circle_50px_at_10px_10px,#fff_0%,#000_100%)]"}},
		{"shadows", Prop{"box-shadow", "inset 0 0 0 2px #000,0 4px 8px rgba(0,0,0,0.25)"}, []string{"shadow-[inset_0_0_0_2px_#000,0_4px_8px_rgba(0,0,0,0.25)]"}},
		{"opacity 50", Prop{"opacity", "0.5"}, []string{"opacity-50"}},
		{"opacity 0.35", Prop{"opacity", "0.35"}, []string{"opacity-35"}},
		{"fractional opacity", Prop{"opacity", "0.333"}, []string{"opacity-[0.333]"}},
		{"blur", Prop{"filter", "blur(4px)"}, []string{"blur-[4px]"}},
		{"compound filter", Prop{"filter", "drop-shadow(5px 5px 0 rgba(0,0,0,0.4)) blur(2px)"}, []string{"[filter:drop-shadow(5px_5px_0_rgba(0,0,0,0.4))_blur(2px)]"}},
		{"object-fit", Prop{"object-fit", "fill"}, []string{"object-fill"}},
		{"max-width none", Prop{"max-width", "none"}, []string{"max-w-none"}},
		{"family", Prop{"font-family", "Inter, sans-serif"}, []string{"[font-family:Inter,_sans-serif]"}},
		{"family with spaces", Prop{"font-family", "Open Sans, sans-serif"}, []string{"[font-family:Open_Sans,_sans-serif]"}},
		{"size", Prop{"font-size", "16px"}, []string{"text-[16px]"}},
		{"weight 400", Prop{"font-weight", "400"}, []string{"font-normal"}},
		{"weight 600", Prop{"font-weight", "600"}, []string{"font-semibold"}},
		{"weight 700", Prop{"font-weight", "700"}, []string{"font-bold"}},
		{"weight 550", Prop{"font-weight", "550"}, []string{"font-[550]"}},
		{"weight bold", Prop{"font-weight", "bold"}, []string{"[font-weight:bold]"}},
		{"line height", Prop{"line-height", "1.2"}, []string{"leading-[1.2]"}},
		{"align center", Prop{"text-align", "center"}, []string{"text-center"}},
		{"align right", Prop{"text-align", "right"}, []string{"text-right"}},
		{"text colour", Prop{"color", "#1a1a1f"}, []string{"text-[#1a1a1f]"}},
		{"transparent colour", Prop{"color", "transparent"}, []string{"text-transparent"}},
		{"pre-wrap", Prop{"white-space", "pre-wrap"}, []string{"whitespace-pre-wrap"}},
		{"pre", Prop{"white-space", "pre"}, []string{"whitespace-pre"}},
		{"wrap", Prop{"overflow-wrap", "break-word"}, []string{"break-words"}},
		{"text clip", Prop{"background-clip", "text"}, []string{"bg-clip-text"}},
		{"text clip webkit", Prop{"-webkit-background-clip", "text"}, nil},
		{"cursor", Prop{"cursor", "pointer"}, []string{"cursor-pointer"}},
		{"text stroke", Prop{"-webkit-text-stroke", "1px #f80"}, []string{"[-webkit-text-stroke:1px_#f80]"}},
		{"text shadow", Prop{"text-shadow", "3px 3px 4px rgba(0,0,0,0.4)"}, []string{"[text-shadow:3px_3px_4px_rgba(0,0,0,0.4)]"}},
		{"unknown property", Prop{"mix-blend-mode", "multiply"}, []string{"[mix-blend-mode:multiply]"}},
		{"real underscore", Prop{"font-family", "Foo_Bar"}, []string{`[font-family:Foo\_Bar]`}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := tailwindFor(c.prop)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("tailwindFor(%v) = %q, want %q", c.prop, got, c.want)
			}
		})
	}
}

// The delivered example: an auto layout frame.
func TestTailwindClassesExample(t *testing.T) {
	got := className([]Prop{
		{"display", "flex"}, {"flex-direction", "column"}, {"gap", "8px"}, {"padding", "16px"},
		{"border-radius", "12px"}, {"background-color", "#fff"}, {"width", "320px"},
	})
	want := "flex flex-col gap-[8px] p-[16px] rounded-[12px] bg-[#fff] w-[320px]"
	if got != want {
		t.Errorf("className = %q, want %q", got, want)
	}
}
