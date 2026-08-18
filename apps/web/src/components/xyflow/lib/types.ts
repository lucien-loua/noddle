import type { Node } from "@xyflow/react";

export interface NodeData<TType extends string = string> extends Record<
  string,
  unknown
> {
  label: string;
  type: TType;
}

export type FlowNode<TType extends string = string> = Node<NodeData<TType>>;
