/**
 * Movie-theatre stage backdrop. Pure CSS — two velvet curtain panels with
 * vertical pleats, a top valance, gold tassels, and a darkened stage in
 * the centre where content sits. Sits behind everything (z=0); modals and
 * the player are unaffected.
 */
export function Theatre() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      {/* Stage glow — soft top-down spotlight */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(255, 200, 140, 0.12), transparent 70%), radial-gradient(ellipse 80% 60% at 50% 110%, rgba(120, 30, 30, 0.4), transparent 70%)",
        }}
      />

      {/* Top valance — red velvet swag along the top edge */}
      <div
        className="absolute left-0 right-0 top-0 h-24 md:h-28"
        style={{
          background:
            "linear-gradient(to bottom, #5a0a0a 0%, #8b0e0e 40%, #6a0707 100%)",
          borderBottom: "3px solid #2a0202",
          boxShadow: "0 4px 16px rgba(0,0,0,0.6) inset, 0 6px 16px rgba(0,0,0,0.5)",
        }}
      >
        {/* Repeating scallop / fringe along bottom of valance */}
        <div
          className="absolute -bottom-3 left-0 right-0 h-6"
          style={{
            background:
              "radial-gradient(circle at 24px 0, #6a0707 14px, transparent 15px) 0 0/48px 24px repeat-x",
            filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.5))",
          }}
        />
        {/* Subtle pleat shading on the valance */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "repeating-linear-gradient(to right, rgba(0,0,0,0.25) 0px, rgba(0,0,0,0) 18px, rgba(0,0,0,0.25) 36px)",
            mixBlendMode: "multiply",
          }}
        />
      </div>

      {/* Left curtain panel */}
      <CurtainPanel side="left" />
      {/* Right curtain panel */}
      <CurtainPanel side="right" />

      {/* Stage floor — subtle darker band at very bottom */}
      <div
        className="absolute bottom-0 left-0 right-0 h-32"
        style={{
          background:
            "linear-gradient(to bottom, transparent, rgba(0,0,0,0.5))",
        }}
      />
    </div>
  );
}

function CurtainPanel({ side }: { side: "left" | "right" }) {
  const isLeft = side === "left";
  return (
    <div
      className={`absolute top-0 bottom-0 ${isLeft ? "left-0" : "right-0"} hidden md:block`}
      style={{
        width: "clamp(160px, 22vw, 360px)",
        // Velvet base color, vertical gradient (slightly lighter top, darker bottom)
        background:
          "linear-gradient(to bottom, #6a0808 0%, #8b0e0e 35%, #6a0707 75%, #3a0303 100%)",
      }}
    >
      {/* Vertical pleats — alternating dark/light bands */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "repeating-linear-gradient(to right, rgba(0,0,0,0.55) 0px, rgba(0,0,0,0.0) 14px, rgba(255,255,255,0.06) 22px, rgba(0,0,0,0.0) 30px, rgba(0,0,0,0.55) 44px)",
        }}
      />
      {/* Subtle horizontal weave / gather */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "repeating-linear-gradient(to bottom, rgba(0,0,0,0.0) 0px, rgba(0,0,0,0.15) 1px, rgba(0,0,0,0.0) 4px)",
          mixBlendMode: "multiply",
        }}
      />
      {/* Inner edge — curtain gather/shadow facing the stage */}
      <div
        className={`absolute top-0 bottom-0 w-12 md:w-20 ${isLeft ? "right-0" : "left-0"}`}
        style={{
          background: isLeft
            ? "linear-gradient(to right, transparent, rgba(0,0,0,0.6))"
            : "linear-gradient(to left, transparent, rgba(0,0,0,0.6))",
        }}
      />
      {/* Highlight along the outer fold */}
      <div
        className={`absolute top-0 bottom-0 w-2 ${isLeft ? "left-0" : "right-0"}`}
        style={{
          background: isLeft
            ? "linear-gradient(to right, rgba(255,180,160,0.18), transparent)"
            : "linear-gradient(to left, rgba(255,180,160,0.18), transparent)",
        }}
      />
      {/* Gold tieback rope — pulls the curtain back roughly mid-way */}
      <Tieback side={side} />
    </div>
  );
}

function Tieback({ side }: { side: "left" | "right" }) {
  const isLeft = side === "left";
  return (
    <div
      className="absolute"
      style={{
        top: "48%",
        [isLeft ? "right" : "left"]: "-8px",
        width: "62%",
        height: "44px",
        transform: isLeft ? "rotate(-8deg)" : "rotate(8deg)",
        transformOrigin: isLeft ? "right center" : "left center",
      }}
    >
      {/* Twisted gold cord */}
      <div
        className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "repeating-linear-gradient(45deg, #c9a23c 0 4px, #fff1a8 4px 6px, #8a6a18 6px 10px)",
          boxShadow: "0 2px 4px rgba(0,0,0,0.5)",
        }}
      />
      {/* Tassel hanging from the inner end */}
      <div
        className={`absolute top-1/2 ${isLeft ? "right-0" : "left-0"} flex flex-col items-center`}
        style={{ transform: "translateY(-2px)" }}
      >
        <div
          className="h-3 w-3 rounded-full"
          style={{
            background: "radial-gradient(circle at 35% 30%, #fff1a8, #c9a23c 70%, #8a6a18)",
            boxShadow: "0 2px 3px rgba(0,0,0,0.6)",
          }}
        />
        <div
          className="h-6 w-2"
          style={{
            background:
              "repeating-linear-gradient(to bottom, #c9a23c 0 2px, #8a6a18 2px 4px)",
            borderRadius: "0 0 2px 2px",
            boxShadow: "0 2px 3px rgba(0,0,0,0.5)",
          }}
        />
      </div>
    </div>
  );
}
