import type { Node, NodeProps } from "@xyflow/react";
import type { ComponentType } from "react";

export interface NodeData<
  TType extends string = string,
  TParams = Record<string, unknown>,
> extends Record<string, unknown> {
  label: string;
  type: TType;
  params: Partial<TParams>;
  icon?: string;
}

export type FlowNode<
  TType extends string = string,
  TParams = Record<string, unknown>,
> = Node<NodeData<TType, TParams>>;

export interface NodePanelProps<TParams = Record<string, unknown>> {
  nodeId: string;
  params: Partial<TParams>;
  onChange: (param: string, value: number | string | boolean) => void;
  onXYPadChange: (params: Record<string, number>) => void;
}

export interface NodeDefinition<
  TType extends string = string,
  TCategory extends string = string,
  TParams = Record<string, unknown>,
> {
  type: TType;
  component: ComponentType<NodeProps<FlowNode<TType, TParams>>>;
  panel: ComponentType<NodePanelProps<TParams>>;
  category: TCategory;
  label: string;
  description: string;
}

export interface LooseNodeDefinition<
  TType extends string = string,
  TCategory extends string = string,
  TParams = Record<string, unknown>,
> {
  type: TType;
  component: ComponentType<NodeProps<Node>>;
  panel: ComponentType<NodePanelProps<TParams>>;
  category: TCategory;
  label: string;
  description: string;
}

export interface NodeCategoryGroup<
  TType extends string = string,
  TCategory extends string = string,
> {
  name: TCategory;
  nodes: {
    type: TType;
    label: string;
    description: string;
  }[];
}
