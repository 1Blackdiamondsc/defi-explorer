import { Injectable } from '@angular/core';

@Injectable()
export class DefaultProvider {
  private defaults: {
    '%CHAIN%': string;
    '%API_PREFIX%': string;
    '%NETWORK%': string;
    '%NUM_BLOCKS%': string;
    '%DEFI_CHAIN_STATS%': string;
  } = {
    '%CHAIN%': process.env.CHAIN || 'BTC',
    '%API_PREFIX%': process.env.API_PREFIX || '/api',
    '%NETWORK%': process.env.NETWORK || 'mainnet',
    '%NUM_BLOCKS%': process.env.NUM_BLOCKS || '20',
    '%DEFI_CHAIN_STATS%': 'https://api.defichain.io/v1/stats'
  };

  constructor() {}

  public getDefault(str: string): string {
    return this.defaults[str] !== undefined ? this.defaults[str] : str;
  }

  public setDefault(str: string, value: any): void {
    this.defaults[str] = value;
  }
}