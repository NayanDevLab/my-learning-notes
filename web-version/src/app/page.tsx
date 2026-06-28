import { redirect } from "next/navigation";
import { getNavTree } from "@/lib/content";
import type { NavItem } from "@/lib/content";

function firstLeaf(items: NavItem[]): string[] | null {
  for (const item of items) {
    if (item.type === "leaf") return item.slug;
    const found = firstLeaf(item.children);
    if (found) return found;
  }
  return null;
}

export default function Home() {
  const tree = getNavTree();
  const first = firstLeaf(tree);
  if (first) {
    redirect(`/${first.join("/")}`);
  }
  return <div>No notes found.</div>;
}
