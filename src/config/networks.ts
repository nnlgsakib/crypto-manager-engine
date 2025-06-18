// src/config/networks.ts
export const networks: Record<string, NetworkConfig> = {
  mind: {
    rpcUrl: 'ws://194.163.189.70:8545/ws',
    httpRpcUrl: 'http://194.163.189.70:8545',
    chainId: 9996,
    nativeCurrency: 'MIND',
    requiredConfirmations: 10,
    min_withdrawal: '1',
    max_withdrawal: '10000',
    withdrawal_fee: '1',
    min_deposit: '0.001',
    withdrawal_processor_contract_address:
      '0xe95b5c7B1bfFe1D1796e58Cb18da7D76100d6020',
    erc20Tokens: {
      USDT: {
        address: '0x32a8a2052b48Da5FD253cC8B386B88B3E0BF50eE',
        decimals: 18,
        min_withdrawal: '1',
        max_withdrawal: '10000',
        withdrawal_fee: '1',
        min_deposit: '0.001',
      },
      MUSD: {
        address: '0xaC264f337b2780b9fd277cd9C9B2149B43F87904',
        decimals: 18,
        min_withdrawal: '1',
        max_withdrawal: '10000',
        withdrawal_fee: '1',
        min_deposit: '0.001',
      },
    },
  },
};

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
