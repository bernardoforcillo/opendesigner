import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { DocumentService } from "../gen/opendesigner/v1/opendesigner_pb";

import type { Interceptor } from "@connectrpc/connect";
import { activeToken } from "./access";

// Every request carries the link token of the document the editor is on (see rpc/access.ts); with
// none it carries nothing and an unprotected document works as it always did.
const withLink: Interceptor = (next) => async (req) => {
  const token = activeToken();
  if (token !== "") req.header.set("Authorization", `Bearer ${token}`);
  return next(req);
};

const transport = createConnectTransport({ baseUrl: "/", interceptors: [withLink] });
export const docClient = createClient(DocumentService, transport);
