import { obfuscateText } from "./tools";

// Fancy Unicode fonts for channel names (like discord-fonts.com styles).
// Maps are built arithmetically from Unicode blocks; known holes in the
// italic/script blocks are patched explicitly. Anything unmapped falls
// back to the original character.

function letterMap(base: number, holes: Record<number, number> = {}): Record<string, string> {
    const m: Record<string, string> = {};
    for (let i = 0; i < 26; i++) {
        m[String.fromCharCode(97 + i)] = String.fromCodePoint(holes[i] ?? base + i);
    }
    return m;
}

function digitMap(base: number, zeroOverride?: number): Record<string, string> {
    const m: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
        m[String.fromCharCode(48 + i)] = String.fromCodePoint(i === 0 && zeroOverride ? zeroOverride : base + i);
    }
    return m;
}

type StyleDef = { letters: Record<string, string>; digits?: Record<string, string>; hyphen?: string };

const STYLES: Record<string, StyleDef> = {
    // 𝐝𝐨𝐧𝐭-𝐜𝐡𝐚𝐭
    bold: { letters: letterMap(0x1D41A), digits: digitMap(0x1D7CE) },
    // 𝑎-𝑧 (italic small h lives at U+210E, not in the block)
    italic: { letters: letterMap(0x1D44E, { 7: 0x210E }) },
    // 𝒂-𝒛
    boldItalic: { letters: letterMap(0x1D482) },
    // 𝒶-𝓏 (e/g/o live outside the block)
    script: { letters: letterMap(0x1D4B6, { 4: 0x212F, 6: 0x210A, 14: 0x2134 }) },
    // 𝔞-𝔷
    fraktur: { letters: letterMap(0x1D51E) },
    // 𝕒-𝕫
    doubleStruck: { letters: letterMap(0x1D552) },
    // 𝚊-𝚣
    monospace: { letters: letterMap(0x1D68A), digits: digitMap(0x1D7F6) },
    // ⓐ-ⓩ
    circled: { letters: letterMap(0x24D0), digits: digitMap(0x2460, 0x24EA) },
    // ａ-ｚ
    fullwidth: { letters: letterMap(0xFF41), digits: digitMap(0xFF10), hyphen: "－" },
};

export type FontStyle = keyof typeof STYLES;
export const FONT_STYLE_NAMES = Object.keys(STYLES) as FontStyle[];

export function styleChannelName(name: string, style: FontStyle): string {
    const s = STYLES[style];
    if (!s) return name;
    let out = "";
    for (const ch of name.toLowerCase()) {
        if (ch >= "a" && ch <= "z") out += s.letters[ch] ?? ch;
        else if (ch >= "0" && ch <= "9") out += s.digits?.[ch] ?? ch;
        else if (ch === "-") out += s.hyphen ?? "-";
        else out += ch;
    }
    return out;
}

export function randomFontStyle(): FontStyle {
    return FONT_STYLE_NAMES[Math.floor(Math.random() * FONT_STYLE_NAMES.length)]!;
}

// Chaos rotation: only the "broken-looking" styles. Bold/italic/boldItalic
// look too normal for chaos, so they stay out here.
export const CHAOS_FONT_STYLES: FontStyle[] = ["script", "fraktur", "doubleStruck", "monospace", "circled", "fullwidth"];

/** Chaos-mode name: gibberish, fancy font, or lookalike-obfuscated. */
export function randomChaosName(baseNames: string[]): string {
    const pick = () => baseNames[Math.floor(Math.random() * baseNames.length)] ?? "honeypot";
    const roll = Math.random();
    if (roll < 0.4) {
        const length = Math.floor(Math.random() * 20) + 7;
        const chars = "abcdefghijklmnopqrstuvwxyz0123456789-";
        let gibberish = "";
        for (let i = 0; i < length; i++) gibberish += chars.charAt(Math.floor(Math.random() * chars.length));
        return gibberish;
    }
    if (roll < 0.7) {
        const style = CHAOS_FONT_STYLES[Math.floor(Math.random() * CHAOS_FONT_STYLES.length)]!;
        return styleChannelName(pick(), style);
    }
    return obfuscateText(pick(), 0.5);
}
