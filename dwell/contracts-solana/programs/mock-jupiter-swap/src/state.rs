use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

pub const SWAP_STATE_SEED: &[u8] = b"swap_state";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct SwapState {
    pub is_initialized: bool,
    pub authority: Pubkey,
    pub dwell_mint: Pubkey,
    pub usdc_mint: Pubkey,
    /// DWELL base units paid out per 1_000_000 USDC base units in.
    pub rate: u64,
}

impl SwapState {
    pub const LEN: usize = 1 + 32 + 32 + 32 + 8;
}
