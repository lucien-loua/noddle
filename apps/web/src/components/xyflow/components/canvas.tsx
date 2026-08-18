"use client";

import { Background, BackgroundVariant, ReactFlow } from "@xyflow/react";
import type { Edge, Node, ReactFlowProps } from "@xyflow/react";

import "@xyflow/react/dist/style.css";

function FlowCanvas<
  NodeType extends Node = Node,
  EdgeType extends Edge = Edge,
>({
  children,
  ...props
}: React.PropsWithChildren<ReactFlowProps<NodeType, EdgeType>>) {
  return (
    <ReactFlow<NodeType, EdgeType>
      // A topology is read: panning and zooming, never editing. Backspace
      // deleting a node would be a silent lie about what is deployed.
      deleteKeyCode={null}
      fitView
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      snapGrid={[16, 16]}
      snapToGrid
      {...props}
    >
      <Background
        className="opacity-50"
        gap={20}
        size={1}
        variant={BackgroundVariant.Dots}
      />
      {children}
    </ReactFlow>
  );
}

export { FlowCanvas };
