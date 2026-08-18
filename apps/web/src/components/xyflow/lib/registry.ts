import type { Node, NodeProps } from "@xyflow/react";
import type { ComponentType } from "react";

import type {
  LooseNodeDefinition,
  NodeCategoryGroup,
  NodeDefinition,
  NodePanelProps,
} from "./types";

export class NodeRegistry<
  TType extends string = string,
  TCategory extends string = string,
> {
  private readonly nodes = new Map<
    TType,
    LooseNodeDefinition<TType, TCategory>
  >();

  register<T extends TType, TParams>(
    definition: NodeDefinition<T, TCategory, TParams>
  ) {
    this.nodes.set(
      definition.type,
      definition as unknown as LooseNodeDefinition<TType, TCategory>
    );
  }

  get<T extends TType, TParams = Record<string, unknown>>(
    type: T
  ): NodeDefinition<T, TCategory, TParams> | undefined {
    return this.nodes.get(type) as
      | NodeDefinition<T, TCategory, TParams>
      | undefined;
  }

  getAll(): LooseNodeDefinition<TType, TCategory>[] {
    return [...this.nodes.values()];
  }

  getNodeTypes(): Record<TType, ComponentType<NodeProps<Node>>> {
    const types = {} as Record<TType, ComponentType<NodeProps<Node>>>;
    for (const [type, definition] of this.nodes) {
      types[type] = definition.component;
    }
    return types;
  }

  getPanel(type: TType): ComponentType<NodePanelProps> | undefined {
    return this.nodes.get(type)?.panel;
  }

  getNodeCategories(): NodeCategoryGroup<TType, TCategory>[] {
    const categoriesMap = new Map<
      TCategory,
      NodeCategoryGroup<TType, TCategory>
    >();

    for (const nodeDef of this.getAll()) {
      const existing = categoriesMap.get(nodeDef.category);
      if (existing) {
        existing.nodes.push({
          type: nodeDef.type,
          label: nodeDef.label,
          description: nodeDef.description,
        });
        continue;
      }

      categoriesMap.set(nodeDef.category, {
        name: nodeDef.category,
        nodes: [
          {
            type: nodeDef.type,
            label: nodeDef.label,
            description: nodeDef.description,
          },
        ],
      });
    }

    return [...categoriesMap.values()].filter(
      (category) => category.nodes.length > 0
    );
  }
}
