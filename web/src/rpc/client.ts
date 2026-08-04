import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { DocumentService } from "../gen/opendesigner/v1/opendesigner_pb";

const transport = createConnectTransport({ baseUrl: "/" });
export const docClient = createClient(DocumentService, transport);
