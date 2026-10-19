"""Prints the API's OpenAPI spec. The extension generates its TypeScript types from it (npm run api:types)."""

import json

from app.main import app

if __name__ == "__main__":
    print(json.dumps(app.openapi(), indent=2))
