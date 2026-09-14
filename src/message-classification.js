import properties from "./classification-contract.cjs";

export const classificationToolProperties = properties;
export function classificationArguments(args) {
  const result = {};
  for (const field of ["nature", "asks"]) {
    if (args[field] === undefined) continue;
    const scalar = field === "nature" && typeof args[field] === "string";
    const labels = scalar ? [args[field]] : args[field];
    const schema = field === "nature" ? properties.nature.anyOf[0] : properties.asks;
    if (!Array.isArray(labels) || labels.length > schema.maxItems || new Set(labels).size !== labels.length || labels.some((label) => !schema.items.enum.includes(label))) {
      throw new Error(`${field} must contain unique supported labels.`);
    }
    result[field] = scalar ? args[field] : labels;
  }
  return result;
}
