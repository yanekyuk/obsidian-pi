import { setIcon } from "obsidian";
import type { ImageContent } from "../rpc/types";

// pi resizes images it reads itself (images.autoResize), but not ones a client sends
// over RPC, so apply the same 2000px bound here before they reach the model.
const MAX_EDGE = 2000;
const PASSTHROUGH = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function toBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
		reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image"));
		reader.readAsDataURL(blob);
	});
}

async function encode(file: Blob): Promise<ImageContent> {
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
		// Untouched bytes when possible: re-encoding would drop GIF animation and cost quality.
		if (scale === 1 && PASSTHROUGH.has(file.type)) return { type: "image", data: await toBase64(file), mimeType: file.type };

		const canvas = createEl("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		// Photos stay JPEG to keep the payload small; everything else becomes PNG to keep transparency.
		const mimeType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, 0.9));
		if (!blob) throw new Error("Couldn't convert the image");
		return { type: "image", data: await toBase64(blob), mimeType };
	} finally {
		bitmap.close();
	}
}

export function imageSrc(image: ImageContent): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

export function imageFilesOf(transfer: DataTransfer | null): File[] {
	return Array.from(transfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
}

// Images waiting to go out with the next message, shown as thumbnails in the composer.
export class AttachmentTray {
	private el: HTMLElement;
	private images: ImageContent[] = [];

	constructor(
		parent: HTMLElement,
		private onChange: () => void = () => {},
	) {
		this.el = parent.createDiv({ cls: "pi-attachments" });
	}

	get count(): number {
		return this.images.length;
	}

	// Returns how many of the files could not be read as images.
	async add(files: Blob[]): Promise<number> {
		const results = await Promise.allSettled(files.map(encode));
		for (const r of results) if (r.status === "fulfilled") this.images.push(r.value);
		this.render();
		return results.filter((r) => r.status === "rejected").length;
	}

	take(): ImageContent[] {
		const images = this.images;
		this.images = [];
		this.render();
		return images;
	}

	restore(images: ImageContent[]): void {
		this.images = [...images, ...this.images];
		this.render();
	}

	private render(): void {
		this.onChange();
		this.el.empty();
		this.images.forEach((image, i) => {
			const item = this.el.createDiv({ cls: "pi-attachment" });
			item.createEl("img", { attr: { src: imageSrc(image), alt: "Attached image" } });
			const remove = item.createEl("button", { cls: "pi-attachment-remove", attr: { "aria-label": "Remove image" } });
			setIcon(remove, "x");
			remove.addEventListener("click", () => {
				this.images.splice(i, 1);
				this.render();
			});
		});
	}
}
