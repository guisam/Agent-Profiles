// Exact-tuple binding targeting, shared by promotion (#25) and update (#48).
// The resolver selects the unique containment-maximal matching rule, so every other
// matching rule is a subset of the selected one: replace it when it already pins the
// exact tuple (its other qualifiers already match), otherwise add one rule that keeps
// its qualifiers and pins the tuple, which strictly contains every matching rule.
import { createHash } from "node:crypto";

export type Assignment = { role: string; model: string; host: string };
export type SelectedBinding = {
	selectedBy: string;
	selectors?: Record<string, unknown>;
};
export type BindingTarget = {
	id: string;
	when: Record<string, unknown>;
	action: "replace" | "add";
};

/** A stable rule id for an added exact rule: `<prefix>-<16 hex>` over the tuple (and profile, when the selected rule had one). */
export const exactRuleId = (
	prefix: string,
	{ role, model, host, profile }: Record<string, unknown>,
) =>
	`${prefix}-${createHash("sha256")
		.update(
			JSON.stringify(
				profile === undefined
					? [role, model, host]
					: [role, model, host, profile],
			),
		)
		.digest("hex")
		.slice(0, 16)}`;

export function exactRule(
	selected: SelectedBinding,
	{ role, model, host }: Assignment,
	prefix: string,
): BindingTarget {
	const selectors =
		selected.selectedBy === "binding-default" ? {} : (selected.selectors ?? {});
	if (
		selected.selectedBy !== "binding-default" &&
		selectors.role === role &&
		selectors.model === model &&
		selectors.host === host
	)
		return {
			id: selected.selectedBy,
			when: { ...selectors },
			action: "replace",
		};
	const when = { ...selectors, role, model, host };
	return { id: exactRuleId(prefix, when), when, action: "add" };
}
