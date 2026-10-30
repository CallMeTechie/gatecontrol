'use strict';

// gc.mail.sanitize(html, { images: 'placeholder' }) (since 1.216.0): the HTML
// of a mail made harmless for showing it — strict allowlisting with
// sanitize-html, CSS of <style> blocks and style attributes reduced to an
// allowlist of properties without url(), expressions or escapes (postcss).
//
//   * no script, form, iframe, object/embed, svg/math, meta, base, link, no
//     event attributes, no javascript:/data:/vbscript: links;
//   * links keep http(s)/mailto/tel/#anchor and get target=_blank
//     rel="noopener noreferrer";
//   * external pictures become src="gc-img:<n>" (n = index in `images`, the
//     same address once); cid: pictures stay cid:, small data:image pictures
//     (PNG, JPEG, GIF, WebP) stay; anything else loses the picture;
//   * known tracking pixels (1×1 / hidden pictures, known tracker hosts and
//     paths) are removed and counted (`trackers`).
//
// Nothing of the mail may load anything by itself afterwards: no url() in
// CSS (background pictures are dropped), no @import / @font-face, no srcset.

const sanitizeHtml = require('sanitize-html');

const HTML_MAX = 10 * 1024 * 1024;
const IMAGES_MAX = 500;
const CSS_MAX = 512 * 1024;
const DATA_IMAGE_MAX = 256 * 1024;

const TAGS = ['a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small',
  'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr'];

// tags whose content goes with them (the rest of a dropped tag keeps its text)
const DROP_WITH_CONTENT = ['script', 'textarea', 'option', 'noscript', 'title', 'xmp', 'svg', 'math', 'template', 'iframe',
  'object', 'embed', 'applet', 'noembed', 'noframes', 'select', 'frameset', 'frame', 'audio', 'video', 'canvas', 'map'];

const COMMON_ATTRS = ['style', 'class', 'id', 'dir', 'lang', 'title', 'align', 'valign', 'width', 'height', 'bgcolor'];
const ATTRS = {
  '*': COMMON_ATTRS,
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'border', 'hspace', 'vspace'],
  table: ['border', 'cellpadding', 'cellspacing', 'summary', 'frame', 'rules'],
  td: ['colspan', 'rowspan', 'nowrap', 'abbr', 'headers', 'scope'],
  th: ['colspan', 'rowspan', 'nowrap', 'abbr', 'headers', 'scope'],
  col: ['span'],
  colgroup: ['span'],
  font: ['color', 'face', 'size'],
  ol: ['start', 'type', 'reversed'],
  ul: ['type'],
  li: ['value', 'type'],
  blockquote: ['cite', 'type'],
  q: ['cite'],
  del: ['datetime'],
  ins: ['datetime'],
  time: ['datetime'],
  details: ['open'],
  hr: ['size', 'noshade', 'color'],
};

// CSS properties kept (inline and in <style>); position, z-index, content,
// cursor, filter, transform, animation and anything that loads are not.
const CSS_PROPS = new Set(['color', 'background', 'background-color', 'font', 'font-family', 'font-size', 'font-style', 'font-weight',
  'font-variant', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-decoration', 'text-decoration-line',
  'text-decoration-color', 'text-decoration-style', 'text-indent', 'text-transform', 'text-overflow', 'white-space', 'word-break',
  'word-wrap', 'overflow-wrap', 'hyphens', 'vertical-align', 'direction', 'margin', 'margin-top', 'margin-right', 'margin-bottom',
  'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-top', 'border-right',
  'border-bottom', 'border-left', 'border-color', 'border-style', 'border-width', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-radius', 'border-top-left-radius',
  'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius', 'border-collapse', 'border-spacing', 'width',
  'height', 'min-width', 'min-height', 'max-width', 'max-height', 'display', 'float', 'clear', 'table-layout', 'caption-side',
  'empty-cells', 'list-style', 'list-style-type', 'list-style-position', 'opacity', 'visibility', 'overflow', 'overflow-x', 'overflow-y',
  'box-sizing', 'outline', 'outline-color', 'outline-style', 'outline-width', 'text-shadow', 'box-shadow', 'align-items',
  'justify-content', 'flex', 'flex-direction', 'flex-wrap', 'gap', 'column-gap', 'row-gap']);
// a value that could load something, run something or escape the declaration
const CSS_BAD_VALUE_RE = /url\s*\(|image-set|image\s*\(|expression|javascript|vbscript|@import|\\|behavior|binding|var\s*\(|attr\s*\(|env\s*\(|[<>{};`]|\/\*/i;
const CSS_VALUE_RE = /^[^<>{};]{0,500}$/;
const MEDIA_PARAMS_RE = /^[a-z0-9 ():,.\-]{0,200}$/i;

function cssValueOk(prop, value) {
  const v = String(value || '').trim();
  return CSS_PROPS.has(String(prop).toLowerCase()) && CSS_VALUE_RE.test(v) && !CSS_BAD_VALUE_RE.test(v);
}

// sanitize-html's allowedStyles: one pattern per property, the same check for all
const STYLE_PATTERN = { test: (v) => !CSS_BAD_VALUE_RE.test(String(v)) && CSS_VALUE_RE.test(String(v)) };
const ALLOWED_STYLES = { '*': Object.fromEntries([...CSS_PROPS].map((p) => [p, [STYLE_PATTERN]])) };

/** The CSS of <style> blocks → the same rules with allowlisted declarations only ('' when nothing is left). */
function cleanCss(css) {
  const postcss = require('postcss');
  let root;
  try { root = postcss.parse(String(css).slice(0, CSS_MAX)); } catch { return ''; }
  root.walkComments((c) => c.remove());
  root.walkAtRules((r) => {
    // @media only (with a plain query); @import, @font-face, @keyframes, @namespace, @supports … go
    if (String(r.name).toLowerCase() !== 'media' || !MEDIA_PARAMS_RE.test(r.params)) r.remove();
  });
  root.walkRules((rule) => {
    const sel = String(rule.selector || '');
    if (!sel || sel.length > 1000 || /[<>\\@{}]|javascript|expression/i.test(sel)) { rule.remove(); return; }
    rule.walkDecls((d) => { if (!cssValueOk(d.prop, d.value)) d.remove(); });
    if (!rule.nodes || !rule.nodes.length) rule.remove();
  });
  root.walkDecls((d) => { if (d.parent === root) d.remove(); });
  root.walkAtRules((r) => { if (!r.nodes || !r.nodes.length) r.remove(); });
  // never able to close the <style> element it lands in
  return root.toString().replace(/</g, '\\3c ').trim();
}

// ─── Trackers ───────────────────────────────────

const TRACKER_HOSTS = ['google-analytics.com', 'doubleclick.net', 'mailtrack.io', 'mailtrack.com', 'emltrk.com', 'bananatag.com',
  'yesware.com', 'getnotify.com', 'mailstat.us', 'pixel.wp.com', 'mixpanel.com', 'list-manage.com', 'mandrillapp.com',
  'hubspotemail.net', 'hubspotlinks.com', 'hs-analytics.net', 'sparkpostmail.com', 'eotrx.substackcdn.com', 'track.customer.io',
  'pixel.app.returnpath.net', 'trk.klclick.com', 'trk.klclick1.com', 'trk.klclick2.com', 'trk.klclick3.com', 'opens.responder.co.il',
  'pixel.monitor1.returnpath.net', 'mailtrack.me', 'superhuman.com', 'track.getmailspring.com', 'tracking.mailspring.com',
  'mailfoogae.appspot.com', 'pixel.adsafeprotected.com', 'ad.doubleclick.net', 'open.convertkit-mail.com', 'open.convertkit-mail2.com'];
const TRACKER_PATH_RE = /\/(?:track(?:ing)?|trk)\/(?:open|o|view)(?:[/.?]|$)|\/wf\/open|\/open\.(?:gif|png|php|aspx?)(?:\?|$)|\/(?:pixel|beacon|opentrack|openrate)(?:\.gif|\.png|\/|\?|$)|\/e\/o\/|\/oo\/[A-Za-z0-9]/i;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function trackerHost(host) {
  return TRACKER_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

function px(v) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(String(v == null ? '' : v));
  return m ? Number(m[1]) : null;
}

/** Is this picture a tracking pixel? (1×1 or smaller, hidden, or a known tracker) */
function isTracker(url, attribs) {
  const style = String(attribs.style || '').toLowerCase().replace(/\s+/g, '');
  const w = px(attribs.width) ?? px((/(?:^|;)width:([^;]+)/.exec(style) || [])[1]);
  const h = px(attribs.height) ?? px((/(?:^|;)height:([^;]+)/.exec(style) || [])[1]);
  if ((w !== null && w <= 1) && (h !== null && h <= 1)) return true;
  if ((w !== null && w <= 1 && h === null) || (h !== null && h <= 1 && w === null)) return true;
  if (/(?:^|;)display:none|(?:^|;)visibility:hidden|(?:^|;)opacity:0(?:;|$)/.test(style)) return true;
  if (trackerHost(hostOf(url))) return true;
  return TRACKER_PATH_RE.test(String(url).replace(/^https?:\/\/[^/]+/i, ''));
}

// ─── HTML ───────────────────────────────────────

const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const LINK_RE = /^(?:https?:\/\/|mailto:|tel:|#)/i;

/**
 * @param {string} html
 * @param {{ images?: 'placeholder' }} [opts]
 * @returns {{ html: string, images: string[], trackers: number }}
 */
function sanitize(html, opts = {}) {
  const o = opts == null ? {} : opts;
  if (o.images != null && o.images !== 'placeholder') {
    throw Object.assign(new Error("images must be 'placeholder'"), { code: 'ERR_INVALID' });
  }
  const input = String(html == null ? '' : html);
  if (input.length > HTML_MAX) throw Object.assign(new Error('html larger than 10 MB'), { code: 'ERR_INVALID' });
  // <style> blocks: the parser hands over their text (exclusiveFilter), the
  // element itself never reaches the output; the CSS is cleaned on its own
  // and put back in front
  const css = [];
  const images = [];
  const index = new Map();
  let trackers = 0;
  // a picture to drop gets this src; exclusiveFilter then removes the whole tag
  const drop = () => ({ tagName: 'img', attribs: { src: 'gc-drop:1' } });
  const out = sanitizeHtml(input, {
    allowedTags: [...TAGS, 'style'],
    allowVulnerableTags: true,
    allowedAttributes: { ...ATTRS, style: [] },
    allowedStyles: ALLOWED_STYLES,
    nonTextTags: DROP_WITH_CONTENT,
    disallowedTagsMode: 'discard',
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['gc-img', 'cid', 'data', 'gc-drop'] },
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
    allowProtocolRelative: false,
    allowedIframeHostnames: [],
    enforceHtmlBoundary: false,
    parseStyleAttributes: true,
    exclusiveFilter: (frame) => {
      if (frame.tag === 'style') { if (css.length < 64) css.push(frame.text || ''); return true; }
      return frame.tag === 'img' && (!frame.attribs.src || /^gc-drop:/.test(frame.attribs.src));
    },
    transformTags: {
      a: (tagName, attribs) => {
        const a = { ...attribs };
        const href = String(a.href || '').trim();
        if (href && LINK_RE.test(href)) {
          a.href = href;
          if (!href.startsWith('#')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } else { delete a.target; delete a.rel; }
        } else { delete a.href; delete a.target; delete a.rel; }
        return { tagName, attribs: a };
      },
      img: (tagName, attribs) => {
        const a = { ...attribs };
        const src = String(a.src || '').trim();
        delete a.srcset;
        if (/^cid:/i.test(src)) return { tagName, attribs: { ...a, src } };
        if (/^data:/i.test(src)) {
          return src.length <= DATA_IMAGE_MAX && DATA_IMAGE_RE.test(src) ? { tagName, attribs: { ...a, src: src.replace(/\s+/g, '') } } : drop();
        }
        if (!/^https?:\/\//i.test(src)) return drop();
        if (isTracker(src, a)) { trackers++; return drop(); }
        let n = index.get(src);
        if (n === undefined) {
          if (images.length >= IMAGES_MAX) return drop();
          n = images.length;
          images.push(src);
          index.set(src, n);
        }
        return { tagName, attribs: { ...a, src: `gc-img:${n}` } };
      },
    },
  });
  const style = css.map(cleanCss).filter(Boolean).join('\n');
  return { html: (style ? `<style>${style}</style>\n` : '') + out, images, trackers };
}

module.exports = { sanitize, cleanCss, isTracker, HTML_MAX };
