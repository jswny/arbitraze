const encoder = new TextEncoder();

export function normalizePem(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function pemToArrayBuffer(pem: string): ArrayBuffer {
	const base64 = pem
		.replace(/-----BEGIN [^-]+-----/, "")
		.replace(/-----END [^-]+-----/, "")
		.replace(/\s+/g, "");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

export async function importPkcs8PrivateKey(rawPem: string): Promise<CryptoKey> {
	const pem = normalizePem(rawPem);
	if (!/^-----BEGIN PRIVATE KEY-----/.test(pem)) {
		throw new Error(
			"Kalshi key must be an unencrypted PKCS#8 private key (BEGIN PRIVATE KEY)",
		);
	}

	const keyData = pemToArrayBuffer(pem);
	return crypto.subtle.importKey(
		"pkcs8",
		keyData,
		{ name: "RSA-PSS", hash: "SHA-256" },
		false,
		["sign"],
	);
}

export async function signRsaPssBase64(
	key: CryptoKey,
	message: string,
): Promise<string> {
	const data = encoder.encode(message);
	const signature = await crypto.subtle.sign(
		{ name: "RSA-PSS", saltLength: 32 },
		key,
		data,
	);
	return arrayBufferToBase64(signature);
}
