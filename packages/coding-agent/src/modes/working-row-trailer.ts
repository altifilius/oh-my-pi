import { visibleWidth } from "@oh-my-pi/pi-tui";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";

/** Reserve throughput first, then complete resource groups, then the band title. */
export function workingRowTrailer(
	width: number,
	rate: string | undefined,
	resourceLabel: (width: number) => string | undefined,
	title: string | undefined,
): string | undefined {
	if (width <= 0) return undefined;
	let trailer = rate ? truncateToWidth(rate, width, "") : "";
	const resources = resourceLabel(Math.max(0, width - visibleWidth(trailer) - (trailer ? 2 : 0)));
	if (resources) trailer += `${trailer ? "  " : ""}${resources}`;
	const titleWidth = width - visibleWidth(trailer) - (trailer ? 2 : 0);
	if (title && titleWidth > 0) {
		const fittedTitle = truncateToWidth(title, titleWidth, "");
		if (fittedTitle) trailer += `${trailer ? "  " : ""}${fittedTitle}`;
	}
	return trailer || undefined;
}
