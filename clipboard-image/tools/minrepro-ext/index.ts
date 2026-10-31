export default function (pi: any) {
	pi.registerShortcut("alt+o", {
		description: "minrepro: pasteToEditor test",
		handler: (ctx: any) => {
			try {
				console.error("[minrepro] shortcut fired, calling pasteToEditor");
				ctx.ui.pasteToEditor("QZMIN");
				console.error("[minrepro] pasteToEditor returned");
			} catch (e: any) {
				console.error(`[minrepro] ERROR: ${e?.message ?? e}`);
			}
		},
	});
}
