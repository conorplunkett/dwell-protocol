use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum FunderInstruction {
    /// Accounts: [payer(signer,writable), funder_state(writable), treasury,
    ///            dwell_mint, usdc_mint, system_program]
    Initialize { treasury_bps: u16 },
    /// Accounts: [owner(signer), funder_state(writable)]
    SetKeeper { keeper: [u8; 32] },
    /// Accounts: [owner(signer), funder_state(writable)]
    SetShares { treasury_bps: u16 },
    /// Accounts: [owner(signer), funder_state(writable)]
    SetSwapProgram { swap_program: [u8; 32] },
    /// Accounts: [owner(signer), funder_state(writable)]
    Pause,
    /// Accounts: [owner(signer), funder_state(writable)]
    Unpause,
    /// Accounts: [keeper(signer), funder_state(writable),
    ///            campaign_marker(writable), vault_authority,
    ///            funder_usdc_vault(writable), funder_dwell_vault(writable),
    ///            mock_swap_program, swap_state, swap_vault_authority,
    ///            router_dwell_vault(writable), router_usdc_vault(writable),
    ///            distributor_dwell_vault(writable), treasury_dwell_account(writable),
    ///            token_program, system_program]
    SwapAndFund {
        campaign_id: [u8; 32],
        usdc_amount: u64,
        min_dwell_out: u64,
    },
}
