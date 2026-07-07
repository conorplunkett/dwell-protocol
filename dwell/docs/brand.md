---
name: Kinetic Broadcast
colors:
  surface: '#f9f9f9'
  surface-dim: '#dadada'
  surface-bright: '#f9f9f9'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f3f4'
  surface-container: '#eeeeee'
  surface-container-high: '#e8e8e8'
  surface-container-highest: '#e2e2e2'
  on-surface: '#1a1c1c'
  on-surface-variant: '#603e39'
  inverse-surface: '#2f3131'
  inverse-on-surface: '#f0f1f1'
  outline: '#956d67'
  outline-variant: '#ebbbb4'
  surface-tint: '#c00100'
  primary: '#bc0100'
  on-primary: '#ffffff'
  primary-container: '#eb0000'
  on-primary-container: '#fffbff'
  inverse-primary: '#ffb4a8'
  secondary: '#5f5e5e'
  on-secondary: '#ffffff'
  secondary-container: '#e4e2e1'
  on-secondary-container: '#656464'
  tertiary: '#0059ba'
  on-tertiary: '#ffffff'
  tertiary-container: '#0071e8'
  on-tertiary-container: '#fefcff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdad4'
  primary-fixed-dim: '#ffb4a8'
  on-primary-fixed: '#410000'
  on-primary-fixed-variant: '#930100'
  secondary-fixed: '#e4e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1b1c1c'
  on-secondary-fixed-variant: '#474746'
  tertiary-fixed: '#d7e2ff'
  tertiary-fixed-dim: '#acc7ff'
  on-tertiary-fixed: '#001a40'
  on-tertiary-fixed-variant: '#004491'
  background: '#f9f9f9'
  on-background: '#1a1c1c'
  surface-variant: '#e2e2e2'
typography:
  display-lg:
    fontFamily: Sora
    fontSize: 48px
    fontWeight: '800'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Sora
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Sora
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  headline-md:
    fontFamily: Sora
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Sora
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Sora
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Sora
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 16px
  margin-mobile: 16px
  margin-desktop: 24px
  max-width: 1280px
---

## Brand & Style
This design system shifts from a neon-cyber aesthetic to a high-energy, content-first "Kinetic Broadcast" style. It leverages the urgency and clarity of a media platform while maintaining its technical roots. The personality is authoritative, immediate, and highly functional, prioritizing content consumption and clarity over decorative effects.

The style is **Cyber-Minimalist**. It uses pure white surfaces to create a gallery-like environment where the content is the protagonist. The "Dwell Protocol" legacy remains through sharp grid structures and technical precision, but the dark atmosphere is replaced by a surgical, high-contrast light mode that feels professional and expansive.

## Colors
The palette is dominated by a three-color hierarchy: **Vibrant Red**, **Pure White**, and **High-Contrast Black**.

- **Primary Red (#FF0000):** Used exclusively for high-priority actions, branding accents, and "live" indicators. It represents energy and intent.
- **Surface (#FFFFFF):** The bedrock of the UI. No off-whites or subtle tints; pure white ensures maximum contrast and a clean, modern feel.
- **Text & Stroke (#000000 / #282828):** Typography uses deep blacks for maximum legibility. Secondary text uses a dark charcoal (#606060) to maintain hierarchy without sacrificing accessibility.
- **System Accents:** Interactive links or secondary highlights utilize a broadcast blue (#065FD4) to distinguish themselves from primary red actions.

## Typography
The system utilizes **Sora** across all levels to maintain its geometric, technical character. 

Headlines are tight and impactful with negative letter-spacing to mimic broadcast title cards. Body text is kept clean and spacious. Labels use an uppercase treatment with increased tracking to evoke a "metadata" or "protocol" feel. Mobile scaling reduces the display sizes to ensure information density is preserved on smaller viewports.

## Layout & Spacing
The layout follows a strict **12-column fluid grid** for desktop and a **4-column grid** for mobile. 

The rhythm is governed by a 4px base unit. 
- **Gutters:** Fixed at 16px to maintain high density.
- **Margins:** 16px on mobile, scaling to 24px on tablet/desktop.
- **Content Containers:** Use a maximum width of 1280px to ensure line lengths remain readable for data-heavy sections.

Spacing between major sections should be generous (64px+) to allow the white surface to act as a separator, while component-internal spacing should be tight (8px/12px) to maintain the "cyber" density.

## Elevation & Depth
In this design system, depth is communicated through **segmentation rather than shadows**.

- **Tonal Separation:** Instead of shadows, use subtle 1px borders (#EEEEEE) or very light gray backgrounds (#F9F9F9) to define containers.
- **Active State Elevation:** Only "Active" or "Hovered" elements may use a soft, high-diffusion shadow to indicate they are "lifted" from the grid.
- **Overlays:** Modals and menus use a pure white background with a crisp 1px black border and a high-opacity backdrop blur to maintain focus.
- **The "Red Thread":** Primary interactive focus is indicated by a 2px red bottom-border on tabs or navigation items.

## Shapes
The shape language is primarily **Soft (0.25rem)**. This provides a subtle modern friendliness without losing the technical, structural rigidity of the grid.

- **Standard Elements:** (Buttons, Inputs, Small Cards) use 4px (0.25rem) corners.
- **Feature Cards:** Use 8px (0.5rem) to signify a larger container of content.
- **Media Containers:** Thumbnails and video players should maintain sharp or very slightly rounded edges to maximize screen real estate for the content itself.

## Components

### Buttons
- **Primary:** Solid #FF0000 background, white text. No gradient. Rectangular with 4px radius.
- **Secondary:** White background with a 1px #000000 border. Black text.
- **Ghost:** No background or border. Black text. Red text on hover.

### Inputs & Fields
- **Text Fields:** White background with a 1px #CCCCCC border. Focus state changes border color to #000000 and adds a 1px solid black inner stroke. Labels are small and sit above the field.

### Cards & Chips
- **Media Cards:** No borders or shadows by default. Content is separated by white space. Title text is bold, secondary metadata is gray.
- **Chips/Filters:** Light gray (#F2F2F2) background, 4px radius, no border. Active state: Black background with white text.

### Navigation
- **Sidebar:** Clean, vertical list with icons. Active item uses a solid red icon or a red vertical indicator on the left.
- **Search Bar:** Centered at the top, pills-shaped or slightly rounded, with a prominent search icon. Use a subtle gray border to define the hit area.

### Indicators
- **Live/Active:** A solid red circle next to text.
- **Progress Bars:** Solid red fill on a light gray track. High-speed, linear motion for loading states.