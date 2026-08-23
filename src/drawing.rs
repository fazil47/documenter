//! Excalidraw-compatible SVG helpers.

use base64::Engine;

/// Marker comments used by Excalidraw when embedding scene data in SVG.
const PAYLOAD_TYPE: &str = "payload-type:application/vnd.excalidraw+json";
/// Use version 1 for uncompressed UTF-8 JSON base64.
/// Excalidraw treats version 2 as a byte-string of an `encode()` wrapper (optionally deflated).
const PAYLOAD_VERSION: &str = "payload-version:1";

/// Minimal empty Excalidraw scene JSON.
fn empty_scene_json() -> String {
    serde_json::json!({
        "type": "excalidraw",
        "version": 2,
        "source": "documenter",
        "elements": [],
        "appState": {
            "viewBackgroundColor": "#ffffff",
            "gridSize": null
        },
        "files": {}
    })
    .to_string()
}

/// Create a minimal SVG with opaque white background and embedded Excalidraw scene.
pub(crate) fn create_empty_drawing_svg() -> String {
    embed_scene_in_svg(
        &empty_scene_json(),
        "<rect x=\"0\" y=\"0\" width=\"200\" height=\"150\" fill=\"#ffffff\"/>",
    )
}

/// Embed a scene JSON document into an SVG string with an opaque white background rect.
fn embed_scene_in_svg(scene_json: &str, inner_content: &str) -> String {
    embed_scene_in_svg_with_root(
        scene_json,
        inner_content,
        r#"version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150" width="200" height="150""#,
    )
}

/// Embed scene JSON using the given opening `<svg …>` attribute string (without the tag name).
///
/// Payload format matches Excalidraw's `decodeSvgBase64Payload`:
/// - `payload-version:1` → uncompressed UTF-8 JSON (version 2 expects a compressed encode() wrapper)
/// - raw base64 text on a **single line** between markers (JS `.` does not match newlines)
fn embed_scene_in_svg_with_root(
    scene_json: &str,
    inner_content: &str,
    svg_open_attrs: &str,
) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(scene_json.as_bytes());
    // Single-line raw base64: Excalidraw's decoder uses /payload-start -->\s*(.+?)\s*<!-- payload-end/
    // without the /s flag, so `.` cannot span lines.
    format!(
        "<svg {svg_open_attrs}>\n  <!-- {PAYLOAD_TYPE} -->\n  <!-- {PAYLOAD_VERSION} -->\n  <!-- payload-start -->\n{encoded}\n  <!-- payload-end -->\n  <rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>\n  {inner_content}\n</svg>\n"
    )
}

/// Rebuild an Excalidraw `exportToSvg` document so it keeps **visible geometry** and uses
/// our comment-chunk scene payload (reliable re-open + Markdown preview).
pub(crate) fn merge_export_svg_with_scene(export_svg: &str, scene_json: &str) -> String {
    let attrs = extract_svg_open_attrs(export_svg)
        .unwrap_or_else(|| {
            r#"version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150" width="200" height="150""#
                .to_string()
        });
    let (view_w, view_h) = parse_viewbox_size(&attrs).unwrap_or((200.0, 150.0));
    let inner = extract_svg_visual_inner(export_svg);
    // Avoid double white-background rects: strip full-size white rects from export; we add one.
    let inner = strip_full_white_background_rects(&inner);
    // Excalidraw arrow masks are often black punch-outs only (no white cover) → arrows
    // invisible in static SVG viewers while the live canvas still looks fine.
    let inner = repair_excalidraw_masks(&inner, view_w, view_h);
    embed_scene_in_svg_with_root(scene_json, &inner, &attrs)
}

/// Parse `width`/`height` from a `viewBox="minX minY width height"` attribute string.
fn parse_viewbox_size(attrs: &str) -> Option<(f64, f64)> {
    let key = "viewBox=";
    let i = attrs.find(key)?;
    let rest = &attrs[i + key.len()..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let end = rest[1..].find(quote)? + 1;
    let vb = &rest[1..end];
    let parts: Vec<&str> = vb.split_whitespace().collect();
    if parts.len() != 4 {
        return None;
    }
    let w: f64 = parts[2].parse().ok()?;
    let h: f64 = parts[3].parse().ok()?;
    if w > 0.0 && h > 0.0 {
        Some((w, h))
    } else {
        None
    }
}

/// Fix Excalidraw arrow label masks so static SVG viewers show the arrows.
///
/// Official export often emits:
/// ```xml
/// <mask id="…"><rect … fill="#000" …/></mask>  <!-- hole only -->
/// <g mask="url(#…)">…arrow paths…</g>
/// ```
/// SVG masks default to fully transparent; without a white "show everything"
/// layer the black hole alone hides the **entire** masked group.
///
/// Repair: ensure `maskContentUnits="userSpaceOnUse"` and prepend
/// `<rect x="0" y="0" width="{viewW}" height="{viewH}" fill="#ffffff"/>`.
fn repair_excalidraw_masks(inner: &str, view_w: f64, view_h: f64) -> String {
    let mut out = String::with_capacity(inner.len() + 256);
    let mut rest = inner;
    while let Some(mask_at) = rest.find("<mask") {
        out.push_str(&rest[..mask_at]);
        let after = &rest[mask_at..];
        let Some(close_rel) = after.find("</mask>") else {
            out.push_str(after);
            return out;
        };
        let end = close_rel + "</mask>".len();
        let mask_block = &after[..end];
        out.push_str(&repair_one_mask(mask_block, view_w, view_h));
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

fn repair_one_mask(mask_block: &str, view_w: f64, view_h: f64) -> String {
    let Some(gt) = mask_block.find('>') else {
        return mask_block.to_string();
    };
    if !mask_block[gt..].contains("</mask>") {
        return mask_block.to_string();
    }
    let open = &mask_block[..=gt];
    let content = &mask_block[gt + 1..mask_block.len() - "</mask>".len()];

    let content_l = content.to_ascii_lowercase();
    let has_black_punch = content_l.contains("fill=\"#000")
        || content_l.contains("fill='#000")
        || content_l.contains("fill=\"black\"")
        || content_l.contains("fill='black'");
    if !has_black_punch {
        return mask_block.to_string();
    }
    if mask_has_white_cover(content) {
        // Still normalize units so absolute punch-out coordinates work.
        return format!("{}{}</mask>", ensure_mask_user_space(open), content);
    }

    // Escape `{`/`}` not needed; avoid `#` in format_args by concatenating fill.
    let white = format!(
        r#"<rect x="0" y="0" width="{view_w}" height="{view_h}" fill="{fill}"></rect>"#,
        view_w = view_w,
        view_h = view_h,
        fill = "#ffffff",
    );
    format!(
        "{}{}{}</mask>",
        ensure_mask_user_space(open),
        white,
        content
    )
}

fn mask_has_white_cover(content: &str) -> bool {
    let l = content.to_ascii_lowercase();
    let has_white = l.contains("fill=\"#ffffff\"")
        || l.contains("fill=\"#fff\"")
        || l.contains("fill=\"white\"")
        || l.contains("fill='#ffffff'")
        || l.contains("fill='#fff'")
        || l.contains("fill='white'");
    if !has_white {
        return false;
    }
    // Prefer a near-full cover (viewBox-sized or 100%).
    l.contains("width=\"100%\"")
        || l.contains("width='100%'")
        || l.contains("height=\"100%\"")
        || (l.contains("x=\"0\"") && l.contains("y=\"0\""))
        || (l.contains("x='0'") && l.contains("y='0'"))
}

/// Ensure mask coordinates match Excalidraw's absolute punch-out rects.
fn ensure_mask_user_space(open_tag: &str) -> String {
    // open_tag includes the trailing `>`
    if open_tag.contains("maskContentUnits") {
        return open_tag.to_string();
    }
    let without_gt = open_tag.trim_end_matches('>').trim_end();
    format!(r#"{without_gt} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">"#)
}

fn extract_svg_open_attrs(svg: &str) -> Option<String> {
    let start = svg.find("<svg")?;
    let rest = &svg[start + 4..];
    let end = rest.find('>')?;
    let attrs = rest[..end].trim();
    if attrs.is_empty() {
        None
    } else {
        Some(attrs.to_string())
    }
}

/// Content inside the root `<svg>…</svg>`, with Excalidraw/our payload comments removed.
fn extract_svg_visual_inner(svg: &str) -> String {
    let start = match svg.find("<svg") {
        Some(i) => match svg[i..].find('>') {
            Some(j) => i + j + 1,
            None => return String::new(),
        },
        None => return String::new(),
    };
    let end = svg.rfind("</svg>").unwrap_or(svg.len());
    if end <= start {
        return String::new();
    }
    let mut region = svg[start..end].to_string();
    // Drop payload comment blocks (ours or Excalidraw's).
    if let (Some(ps), Some(pe)) = (
        region.find("<!-- payload-start -->"),
        region.find("<!-- payload-end -->"),
    ) {
        let pe_end = pe + "<!-- payload-end -->".len();
        if pe_end > ps {
            region.replace_range(ps..pe_end, "");
        }
    }
    for marker in [
        format!("<!-- {PAYLOAD_TYPE} -->"),
        format!("<!-- {PAYLOAD_VERSION} -->"),
        "<!-- payload-type:application/vnd.excalidraw+json -->".to_string(),
        "<!-- payload-version:2 -->".to_string(),
        "<!-- payload-version:1 -->".to_string(),
    ] {
        region = region.replace(&marker, "");
    }
    // Also strip <metadata>…</metadata> which official export uses for the payload.
    while let Some(ms) = region.find("<metadata") {
        if let Some(rel_end) = region[ms..].find("</metadata>") {
            let me = ms + rel_end + "</metadata>".len();
            region.replace_range(ms..me, "");
        } else {
            break;
        }
    }
    region.trim().to_string()
}

fn strip_full_white_background_rects(inner: &str) -> String {
    // Tag-based (not line-based): Excalidraw often minifies export to few long lines.
    // Removing a whole line would delete geometry that shares the line with the bg rect.
    let mut out = String::new();
    let mut rest = inner;
    while let Some(rect_at) = rest.find("<rect") {
        out.push_str(&rest[..rect_at]);
        let after = &rest[rect_at..];
        // Find end of this rect tag: "/>" or "</rect>"
        let end_rel = after
            .find("/>")
            .map(|i| i + 2)
            .into_iter()
            .chain(after.find("</rect>").map(|i| i + "</rect>".len()))
            .min();
        let Some(end_rel) = end_rel else {
            out.push_str(after);
            return out;
        };
        let tag = &after[..end_rel];
        let l = tag.to_ascii_lowercase();
        let is_white = l.contains("fill=\"#ffffff\"")
            || l.contains("fill=\"#fff\"")
            || l.contains("fill='#ffffff'")
            || l.contains("fill=\"white\"")
            || l.contains("fill='white'");
        let is_full = l.contains("width=\"100%\"")
            || l.contains("width='100%'")
            || (l.contains("x=\"0\"") && l.contains("y=\"0\""))
            || (l.contains("x='0'") && l.contains("y='0'"));
        if !(is_white && is_full) {
            out.push_str(tag);
        }
        rest = &after[end_rel..];
    }
    out.push_str(rest);
    out
}

/// Extract embedded Excalidraw scene JSON from an SVG, if present.
///
/// Supports:
/// - documenter format: base64 chunks inside `<!-- … -->` comments
/// - plain base64 text between payload markers (Excalidraw export without compression)
pub(crate) fn extract_scene_from_svg(svg: &str) -> Option<String> {
    let start_marker = "<!-- payload-start -->";
    let end_marker = "<!-- payload-end -->";
    let start = svg.find(start_marker)? + start_marker.len();
    let end = svg.find(end_marker)?;
    if end <= start {
        return None;
    }
    let region = &svg[start..end];
    let mut b64 = String::new();
    for line in region.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(rest) = t.strip_prefix("<!--")
            && let Some(inner) = rest.strip_suffix("-->")
        {
            b64.push_str(inner.trim());
            continue;
        }
        // Official exports sometimes put base64 as a raw text node between markers.
        if t.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' || c.is_whitespace()
        }) {
            b64.push_str(&t.replace([' ', '\t'], ""));
        }
    }
    if b64.is_empty() {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let json = String::from_utf8(bytes).ok()?;
    // Basic sanity check (also accept wrapper objects that still contain elements).
    if !json.contains("excalidraw") && !json.contains("elements") {
        return None;
    }
    Some(json)
}

/// True if SVG has embedded Excalidraw payload markers.
pub(crate) fn has_embedded_scene(svg: &str) -> bool {
    svg.contains(PAYLOAD_TYPE)
        && svg.contains("payload-start")
        && extract_scene_from_svg(svg).is_some()
}

/// True if SVG declares an opaque white background (common patterns).
pub(crate) fn has_opaque_white_background(svg: &str) -> bool {
    let lower = svg.to_ascii_lowercase();
    lower.contains("fill=\"#ffffff\"")
        || lower.contains("fill=\"#fff\"")
        || lower.contains("fill=\"white\"")
        || lower.contains("fill='#ffffff'")
        || lower.contains("viewbackgroundcolor\":\"#ffffff")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_drawing_round_trips_its_editable_scene() {
        let svg = create_empty_drawing_svg();
        let scene = extract_scene_from_svg(&svg).unwrap();
        let scene: serde_json::Value = serde_json::from_str(&scene).unwrap();
        assert_eq!(scene["type"], "excalidraw");
        assert_eq!(scene["elements"], serde_json::json!([]));
        assert!(has_embedded_scene(&svg));
        assert!(has_opaque_white_background(&svg));
    }

    #[test]
    fn exported_geometry_and_scene_share_one_svg() {
        let export = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30"><path d="M 1 2 L 3 4" stroke="#1b1b1f"/></svg>"##;
        let scene = serde_json::json!({
            "type": "excalidraw",
            "version": 2,
            "elements": [{ "id": "line", "type": "line" }],
            "appState": { "viewBackgroundColor": "#ffffff" },
            "files": {}
        })
        .to_string();
        let merged = merge_export_svg_with_scene(export, &scene);
        assert!(merged.contains("M 1 2 L 3 4"));
        assert_eq!(
            extract_scene_from_svg(&merged).as_deref(),
            Some(scene.as_str())
        );
        assert!(has_opaque_white_background(&merged));
    }
}
