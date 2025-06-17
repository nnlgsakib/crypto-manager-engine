// src/utils/types.ts
export interface NetworkConfig {
  rpcUrl: string;
  httpRpcUrl: string;
  chainId: number;
  nativeCurrency: string;
  requiredConfirmations: number;
  min_withdrawal: string;
  max_withdrawal: string;
  withdrawal_fee: string;
  min_deposit: string;
  withdrawal_processor_contract_address: string;
  erc20Tokens: Record<
    string,
    {
      address: string;
      decimals: number;
      min_withdrawal: string;
      max_withdrawal: string;
      withdrawal_fee: string;
      min_deposit: string;
    }
  >;
}