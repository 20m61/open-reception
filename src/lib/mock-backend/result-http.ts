import { NextResponse } from 'next/server';
import type { Result } from './directory-store';

const ERROR_STATUS = {
  not_found: 404,
  invalid_input: 400,
} as const;

/** ディレクトリ操作の Result を NextResponse に変換する。 */
export function resultResponse<T>(result: Result<T>, successStatus = 200): NextResponse {
  if (result.ok) {
    return NextResponse.json(result.value, { status: successStatus });
  }
  return NextResponse.json(
    { error: result.error.code, message: result.error.message },
    { status: ERROR_STATUS[result.error.code] },
  );
}

/** リクエストボディを JSON として読む。失敗時は null。 */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
