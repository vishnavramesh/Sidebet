// Bot messages go out from a real person's account, so they're set in a
// Unicode "font" to make them obviously the bot at a glance. Local iMessage
// can't send bubble effects or bold/italic, but these characters render
// everywhere. Links stay plain so they still open.
//
// Incoming text is NFKC-normalized, which maps these letters back to ASCII,
// so a copy-pasted "!𝕪𝕖𝕤 𝟜 𝟝" still works as a command. Small caps have no
// NFKC mapping, so plainText() also undoes those by table.

type Font = { upper: number; lower: number; digit: number; holes?: Record<string, string> };

// Small caps aren't a math alphabet: they're scattered phonetic letters with no
// digits, no capitals, and no NFKC mapping back to ASCII, so they get their own
// table both ways. There is no small-cap x; a plain x blends in.
const SMALL_CAPS = Object.fromEntries(
  [..."abcdefghijklmnopqrstuvwxyz"].map((c, i) => [c, [..."ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ"][i]!]),
) as Record<string, string>;
const FROM_SMALL_CAPS = Object.fromEntries(Object.entries(SMALL_CAPS).map(([a, b]) => [b, a]));

const FONTS: Record<string, Font> = {
  // 𝔸𝕒𝟘. Unicode put seven of these capitals in an older block, so map them by hand.
  double: { upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8, holes: { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" } },
  mono: { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 }, // 𝙰𝚊𝟶
  sans: { upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2 }, // 𝖠𝖺𝟢
  bold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec }, // 𝗔𝗮𝟬
};

const choice = process.env.BOT_FONT ?? "smallcaps";
const smallCaps = choice === "smallcaps";
const font = choice === "off" || smallCaps ? null : (FONTS[choice] ?? FONTS.double!);

function convert(s: string): string {
  if (smallCaps) return [...s].map((ch) => SMALL_CAPS[ch.toLowerCase()] ?? ch).join("");
  if (!font) return s;
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (font.holes?.[ch]) out += font.holes[ch];
    else if (c >= 65 && c <= 90) out += String.fromCodePoint(font.upper + c - 65);
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(font.lower + c - 97);
    else if (c >= 48 && c <= 57) out += String.fromCodePoint(font.digit + c - 48);
    else out += ch;
  }
  return out;
}

/** Restyle a bot message, leaving URLs untouched. */
export function botVoice(text: string): string {
  return text
    .split(/(https?:\/\/\S+)/g)
    .map((part, i) => (i % 2 ? part : convert(part)))
    .join("");
}

/** Undo fancy Unicode letters so commands typed or pasted in any font parse. */
export const plainText = (text: string) =>
  [...text.normalize("NFKC")].map((ch) => FROM_SMALL_CAPS[ch] ?? ch).join("");
