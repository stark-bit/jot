// WebSocket protocol between server/ and client/. Types only: both sides
// `import type` from here (see docs/adr/0004-module-boundaries.md).

// Structurally identical to `articulated`'s ElementId and SavedIdList, so the
// server's IdList values satisfy these without the client depending on articulated.
export type ElementId = {
  readonly bunchId: string;
  readonly counter: number;
};

export type SavedIdList = Array<{
  readonly bunchId: string;
  readonly startCounter: number;
  readonly count: number;
  readonly isDeleted: boolean;
}>;

// ---- Client -> server ----

export type ClientInsertMutation = {
  name: "insert";
  args: {
    before: ElementId | null;
    id: ElementId;
    content: string;
    isInWord: boolean;
  };
  clientCounter: number;
};

export type ClientDeleteMutation = {
  name: "delete";
  args: {
    startId: ElementId;
    endId?: ElementId;
    contentLength?: number;
  };
  clientCounter: number;
};

export type ClientMutation = ClientInsertMutation | ClientDeleteMutation;

export type ClientMutationMessage = {
  type: "mutation";
  clientId: string;
  mutations: ClientMutation[];
};

export type PresenceSelection =
  | { type: "cursor"; cursor: ElementId | null }
  | {
      type: "range";
      start: ElementId | null;
      end: ElementId | null;
      direction: "forward" | "backward";
    };

export type ClientPresenceMessage = {
  type: "presence";
  clientId: string;
  selection: PresenceSelection;
};

export type ClientMessage = ClientMutationMessage | ClientPresenceMessage;

// ---- Server -> client ----

export type IdListUpdate =
  | {
      type: "insertAfter";
      before: ElementId | null;
      id: ElementId;
      count: number;
    }
  | {
      type: "deleteRange";
      startIndex: number;
      endIndex: number;
    };

export type ServerHelloMessage = {
  type: "hello";
  clientId?: string;
  noteId: string;
  title: string;
  shareId: string;
  markdown: string;
  idListState: SavedIdList;
  serverCounter: number;
};

export type ServerMutationMessage = {
  type: "mutation";
  senderId: string;
  senderCounter: number;
  serverCounter: number;
  markdown: string;
  idListUpdates: IdListUpdate[];
};

export type ServerPresenceMessage = {
  type: "presence";
  clientId: string;
  name: string;
  color: string;
  selection: PresenceSelection;
};

export type ServerPresenceLeaveMessage = {
  type: "presence-leave";
  clientId: string;
};

export type ServerUpdatedMessage = {
  type: "updated";
  noteId: string;
  shareId: string;
  updatedAt: string;
};

export type ServerThreadsUpdatedMessage = {
  type: "threads-updated";
  noteId: string;
  shareId: string;
};

export type ServerMessage =
  | ServerHelloMessage
  | ServerMutationMessage
  | ServerPresenceMessage
  | ServerPresenceLeaveMessage
  | ServerUpdatedMessage
  | ServerThreadsUpdatedMessage;
