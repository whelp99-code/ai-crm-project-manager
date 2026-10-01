import { postOwner } from "../../handlers";

export function POST(request: Request) {
  return postOwner(request, "confirm");
}
