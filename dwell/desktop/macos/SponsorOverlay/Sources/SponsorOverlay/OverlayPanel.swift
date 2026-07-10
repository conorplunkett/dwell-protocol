// The sponsor card: a small, non-activating floating panel that sits exactly
// on Claude's thinking-star row while it generates (composer, then window
// bottom, as fallbacks) — the native twin of the Chrome extension's inline
// `.bb-bar` (same palette, same pill, same chip/line). On ChatGPT, which has
// no thinking star, it anchors above the composer (then the window bottom).
// It never takes key focus, so typing in the assistant is unaffected.

import AppKit

struct SponsorCard {
    var campaignID: String
    var sponsorName: String
    var message: String // ≤60 chars, validated by overlay-core
    var destinationURL: URL
    var change: Double? // recent-change %, nil when the campaign has no change data
    var logoName: String? // bundled token logo (e.g. "ansem"); nil → letter chip
}

final class OverlayPanelController {
    static let height: CGFloat = 34
    /// Width cap for the content-fitted pill. Wide enough that typical
    /// "Brand · message" lines render whole; only unusually long copy
    /// ellipsizes. (Was 560 — real campaign lines were getting truncated.)
    static let maxWidth: CGFloat = 720
    /// Gap between the card's bottom edge and the composer's top edge. Only the
    /// composer-anchored path (Claude) uses it; ChatGPT anchors off the window
    /// bottom. Sized so a locked card clears Claude's prompt box rather than
    /// sitting on its border.
    static let anchorGap: CGFloat = 28
    /// Fallback when no composer geometry is available: distance from the
    /// bottom of the assistant window (the extension's fixed pill uses 96px too).
    static let bottomInset: CGFloat = 96

    // Overlay palette — mirror of the --ov-* design tokens in the repo-root
    // theme.css (the single source of truth for color). Native Swift can't read
    // theme.css, so these are mirrored by hand: when an --ov-* token changes,
    // update the matching member here in the same commit (AGENTS.md ▸ Design
    // System). Each line is tagged with its canonical token name.
    private enum Palette {
        static let barBackground = NSColor(red: 15/255, green: 15/255, blue: 15/255, alpha: 0.92) // --ov-bar-bg
        static let barBorder = NSColor(white: 1, alpha: 0.05)                                     // --ov-bar-border
        static let dots = NSColor(red: 170/255, green: 170/255, blue: 170/255, alpha: 1)          // --ov-dots     #aaaaaa
        static let chipBackground = NSColor(red: 1, green: 0, blue: 0, alpha: 1)                  // --ov-chip-bg  #ff0000
        static let chipText = NSColor(white: 1, alpha: 1)                                         // --ov-chip-ink #ffffff
        static let line = NSColor(white: 1, alpha: 1)                                             // --ov-line     #ffffff
        // Recent-change % badge — bright green up / red down on the dark bar.
        static let changeUp = NSColor(red: 53/255, green: 208/255, blue: 127/255, alpha: 1)       // #35d07f
        static let changeDown = NSColor(red: 255/255, green: 92/255, blue: 92/255, alpha: 1)      // #ff5c5c
    }

    // Format a recent-change % to the badge string (mirrors formatChangePct in
    // server/src/util.js): signed, ≤3 significant digit-chars, leading zero
    // dropped, magnitude clamped to 999. Empty when there's no change.
    static func formatChange(_ value: Double?) -> String {
        guard let v = value, v.isFinite else { return "" }
        let a = abs(v)
        let body: String
        if a >= 100 { body = String(Int(min(999, (a).rounded()))) }
        else if a >= 10 { body = String(Int(a.rounded())) }
        else if a >= 1 {
            var s = String(format: "%.1f", a)
            if s.hasSuffix(".0") { s.removeLast(2) }  // 9.3, but 9.0 → 9
            body = s
        }
        else if a > 0 {
            var s = String(format: "%.1f", a)
            if s.hasPrefix("0") { s.removeFirst() }   // 0.5 → .5
            if s == ".0" { s = "0" }
            body = s
        } else { body = "0" }
        return "(\(v < 0 ? "-" : "+")\(body)%)"
    }

    // Demo tokens that ship a bundled logo. A card whose brand matches one gets an
    // image chip; anything else (real served ads) keeps the letter chip.
    private static let bundledLogos: Set<String> = ["ansem", "troll", "pepe", "fwog", "chillguy"]
    // Map a brand like "$ansem" to a bundled logo name, or nil if none ships.
    static func tokenLogoName(for brand: String) -> String? {
        let key = brand.trimmingCharacters(in: CharacterSet(charactersIn: "$ ")).lowercased()
        return bundledLogos.contains(key) ? key : nil
    }
    // Load a bundled token logo (reuses the onboarding resource copy, so no extra
    // Package resource). Returns nil if absent — the caller falls back to a letter.
    static func tokenImage(_ name: String) -> NSImage? {
        guard let url = Bundle.module.url(forResource: name, withExtension: "png", subdirectory: "onboarding/tokens") else { return nil }
        return NSImage(contentsOf: url)
    }

    // Layout metrics mirroring the extension bar (padding 14, gap 9, 18px chip).
    private static let padX: CGFloat = 14
    private static let gap: CGFloat = 9
    private static let chipSize: CGFloat = 18

    private var panel: NSPanel?
    private(set) var card: SponsorCard?
    /// Content-fitted width, recomputed whenever the card changes.
    private(set) var panelWidth: CGFloat = 360
    var onClick: ((SponsorCard) -> Void)?
    /// Extra points the card is raised above its composer/bottom anchor,
    /// adjustable from the menu so users place it to taste. Clamped in `show`
    /// so it can never leave the top of the window.
    var verticalLift: CGFloat = 0
    /// Horizontal nudge from the anchor default (+right / -left), clamped to the
    /// window in `show`. 0 keeps the original left/centered position.
    var horizontalShift: CGFloat = 0

    /// Fade timings mirror the Chrome extension's inline bar: quick fade-in,
    /// slow drift-out (inject.css: `transition: opacity 0.25s` in, `2s` out).
    static let fadeInDuration: TimeInterval = 0.25
    static let fadeOutDuration: TimeInterval = 2.0
    private var isFadingIn = false
    private var isFadingOut = false

    /// "Shown" for impression/gating purposes excludes the slow fade-out — once
    /// generation ends and the card starts drifting out it no longer counts as
    /// visible, even though it's still partially on screen.
    var isShown: Bool { (panel?.isVisible ?? false) && !isFadingOut }

    /// Occlusion check feeding overlay-core's `overlay_covered` signal.
    var isCovered: Bool {
        guard let panel, panel.isVisible else { return false }
        return !panel.occlusionState.contains(.visible)
    }

    func setCard(_ newCard: SponsorCard) {
        card = newCard
        if let panel { configureContent(of: panel) }
    }

    /// Positions the pill on the thinking star when its frame is known:
    /// left edge on the star, vertically centered with it, so the card sits
    /// exactly on the star row and tracks it. Without a star it anchors
    /// left-aligned with the composer, `anchorGap` above it; without composer
    /// geometry it falls back to bottom-center of the window.
    func show(over appBounds: CGRect, composer: CGRect? = nil, star: CGRect? = nil) {
        guard card != nil else { return }
        let panel = self.panel ?? makePanel()
        self.panel = panel

        let width = panelWidth
        var x: CGFloat
        var axTop: CGFloat // card's top edge in AX (top-left-origin) coordinates
        if let star, appBounds.intersects(star) {
            // Sit on the star; the lift doesn't apply — it tracks the star row.
            x = star.minX
            axTop = star.midY - Self.height / 2
        } else if let composer, composer.minY > appBounds.minY {
            x = composer.minX
            axTop = composer.minY - Self.anchorGap - Self.height - verticalLift
        } else {
            x = appBounds.midX - width / 2
            axTop = appBounds.maxY - Self.bottomInset - Self.height - verticalLift
        }
        // The lift must never push the card off the top of the window.
        axTop = max(appBounds.minY + 8, axTop)
        // Apply the user's left/right shift (0 = the anchor default), then keep
        // the pill inside the assistant window horizontally.
        x += horizontalShift
        let lower = appBounds.minX + 16
        let upper = max(lower, appBounds.maxX - width - 16)
        x = min(max(x, lower), upper)

        // AX coordinates are top-left-origin; AppKit is bottom-left. Convert.
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        let y = screenH - (axTop + Self.height)
        panel.setFrame(NSRect(x: x, y: y, width: width, height: Self.height), display: true)

        // Fade in on first appearance (or reverse an in-flight fade-out).
        // Steady-state repositions just move the frame above — no re-animation.
        let stable = panel.isVisible && !isFadingOut && !isFadingIn && panel.alphaValue >= 1
        if !stable && !isFadingIn {
            if !panel.isVisible { panel.alphaValue = 0 }
            isFadingOut = false
            isFadingIn = true
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = Self.fadeInDuration
                panel.animator().alphaValue = 1
            }, completionHandler: { [weak self] in
                self?.isFadingIn = false
            })
        }
    }

    /// Hide the card. `animated` (default) does the slow fade-out used when the
    /// assistant is still focused and generation just ended; passing `false`
    /// snaps it off instantly (and cancels any in-flight fade) — used when the
    /// user switches/minimizes away, so the card never lingers over another app.
    func hide(animated: Bool = true) {
        guard let panel, panel.isVisible else { return }
        guard animated else {
            isFadingIn = false
            isFadingOut = false
            panel.orderOut(nil)
            panel.alphaValue = 1
            return
        }
        guard !isFadingOut else { return }
        isFadingIn = false
        isFadingOut = true
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = Self.fadeOutDuration
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self, self.isFadingOut else { return }
            panel.orderOut(nil)
            panel.alphaValue = 1
            self.isFadingOut = false
        })
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: Self.height),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        configureContent(of: panel)
        return panel
    }

    private func configureContent(of panel: NSPanel) {
        guard let card else { return }
        let h = Self.height
        let lineFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)

        let baseText = "\(card.sponsorName) · \(card.message)"
        let badgeText = Self.formatChange(card.change)
        let lineText = badgeText.isEmpty ? baseText : "\(baseText)  \(badgeText)"
        var lineW = ceil(lineText.size(withAttributes: [.font: lineFont]).width)

        // Everything except the (ellipsizable) line is fixed width:
        // padX [chip] gap [line] padX.
        let fixed = Self.padX + Self.chipSize + Self.gap + Self.padX
        lineW = min(lineW, Self.maxWidth - fixed)
        let width = fixed + lineW
        panelWidth = width
        panel.setContentSize(NSSize(width: width, height: h))

        let root = NSView(frame: NSRect(x: 0, y: 0, width: width, height: h))
        root.wantsLayer = true
        root.layer?.backgroundColor = Palette.barBackground.cgColor
        root.layer?.cornerRadius = h / 2
        root.layer?.borderWidth = 1
        root.layer?.borderColor = Palette.barBorder.cgColor

        var x = Self.padX
        // A bundled token logo (demo/known tokens) renders as an image chip;
        // everything else keeps the palette letter chip.
        let chipView: NSView
        if let logo = card.logoName, let image = Self.tokenImage(logo) {
            let iv = NSImageView()
            iv.image = image
            iv.imageScaling = .scaleProportionallyUpOrDown
            iv.wantsLayer = true
            iv.layer?.backgroundColor = Palette.chipBackground.cgColor
            iv.layer?.cornerRadius = 5
            iv.layer?.masksToBounds = true
            chipView = iv
        } else {
            let chip = NSTextField(labelWithString: String(card.sponsorName.prefix(1)).uppercased())
            chip.font = .systemFont(ofSize: 11, weight: .heavy)
            chip.textColor = Palette.chipText
            chip.alignment = .center
            chip.wantsLayer = true
            chip.layer?.backgroundColor = Palette.chipBackground.cgColor
            chip.layer?.cornerRadius = 5
            chipView = chip
        }
        chipView.frame = NSRect(x: x, y: (h - Self.chipSize) / 2, width: Self.chipSize, height: Self.chipSize)
        x += Self.chipSize + Self.gap

        let line = NSTextField(labelWithString: lineText)
        line.font = lineFont
        line.textColor = Palette.line
        line.lineBreakMode = .byTruncatingTail
        line.frame = NSRect(x: x, y: (h - 17) / 2, width: lineW, height: 17)
        // Color just the change badge green/red, leaving the rest --ov-line white.
        if !badgeText.isEmpty {
            let attr = NSMutableAttributedString(string: lineText, attributes: [.font: lineFont, .foregroundColor: Palette.line])
            let range = (lineText as NSString).range(of: badgeText, options: .backwards)
            if range.location != NSNotFound {
                let up = (card.change ?? 0) >= 0
                attr.addAttributes([
                    .foregroundColor: up ? Palette.changeUp : Palette.changeDown,
                    .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .bold),
                ], range: range)
            }
            line.attributedStringValue = attr
        }

        // The whole bar is the click target (like the extension). There is no
        // dismiss control — the card is shown only while the assistant is
        // generating and hides on its own when generation ends.
        for view in [chipView, line] {
            view.addGestureRecognizer(
                NSClickGestureRecognizer(target: self, action: #selector(cardTapped)))
        }

        root.addSubview(chipView)
        root.addSubview(line)
        panel.contentView = root
    }

    @objc private func cardTapped() {
        // Opening is the click handler's job: it routes through the server's
        // single-use tracking URL (or the plain URL in demo mode). Opening
        // here too would double-open the destination.
        guard let card else { return }
        onClick?(card)
    }
}
