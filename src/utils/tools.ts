import { PermissionFlagsBits } from "discord-api-types/v10";

export function getDiscordDate(discordId: string | bigint): number {
    const idBigInt = BigInt(discordId);
    const discordEpochOffset = idBigInt >> 22n;
    const unixTimestampMs = discordEpochOffset + 1420070400000n;
    return Number(unixTimestampMs);
}

export function getDiscordDateMention(date: Date | number): string {
    if (typeof date === "number") {
        return `<t:${Math.floor(date / 1000)}:R>`;
    }
    return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

export function hasPermission(permissions: bigint, permissionBit: bigint) {
    return (permissions & permissionBit) === permissionBit
        || (permissions & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
}

export function snowflakeToBase64(slowflake: string | bigint | number): string {
    const slowflakeBigInt = BigInt(slowflake);
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setBigUint64(0, slowflakeBigInt, false);
    const uint8Array = new Uint8Array(buffer);
    return btoa(String.fromCharCode(...uint8Array)).replace(/=+$/, '');
}

export function base64ToSlowflake(base64: string): bigint {
    const binaryString = atob(base64);
    const uint8Array = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        uint8Array[i] = binaryString.charCodeAt(i);
    }
    return new DataView(uint8Array.buffer).getBigUint64(0, false);
}

export const trim = (str: string, max: number) => str.length > max ? str.slice(0, max - 1) + "…" : str;

import lookalikeChars from "./lookalike-chars.yaml";
const lookalikesData = lookalikeChars as Record<string, string[] | string>;
const reverseLookalikeData: Record<string, string> = {};
for (const [canonicalChar, value] of Object.entries(lookalikesData)) {
    if (Array.isArray(value)) {
        for (const variant of value) reverseLookalikeData[variant] = canonicalChar;
    } else if (typeof value === "string") {
        reverseLookalikeData[value] = canonicalChar;
    }
}

export function obfuscateText(str: string, chance: number = 0.3): string {
    let result = '';
    for (const char of str) {
        const variants = lookalikesData[char];
        if (variants && variants.length > 0 && Math.random() < chance) {
            const randomIndex = variants.length === 1 ? 0 : Math.floor(Math.random() * variants.length);
            result += variants[randomIndex];
        } else {
            result += char;
        }
    }
    return result;
}

export function normalizeText(str: string): string {
    let result = '';
    for (const char of str) {
        result += reverseLookalikeData[char] || char;
    }
    return result;
}
