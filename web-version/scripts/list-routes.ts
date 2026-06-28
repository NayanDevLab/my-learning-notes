import { getAllSlugs, getNavTree } from "../src/lib/content";

const slugs = getAllSlugs();
console.log("Total routes: " + slugs.length);
console.log("---");
for (const s of slugs) {
  console.log("/" + s.join("/"));
}
console.log("---");
console.log("Nav tree (top-level sections):");
for (const item of getNavTree()) {
  if (item.type === "group") {
    const leafCount = countLeaves(item);
    console.log(`  ${item.title} (${leafCount} notes)`);
  }
}

function countLeaves(item: { type: string; children?: any[] }): number {
  if (item.type === "leaf") return 1;
  return (item as any).children?.reduce(
    (n: number, c: any) => n + countLeaves(c),
    0
  ) ?? 0;
}
