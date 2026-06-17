/**
 * 部署ドメイン型 (issue #13, #25)。
 */
export type Department = {
  id: string;
  name: string;
  kana?: string;
  displayOrder: number;
  enabled: boolean;
};
