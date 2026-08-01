import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { DocumentService } from "../gen/brawt/v1/brawt_pb";

const transport = createConnectTransport({ baseUrl: "/" });
export const docClient = createClient(DocumentService, transport);
