use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

use mock_jupiter_swap::instruction::SwapInstruction;
use mock_jupiter_swap::state::{
    SWAP_STATE_SEED, VAULT_AUTHORITY_SEED as SWAP_VAULT_AUTHORITY_SEED,
};

use crate::error::FunderError;
use crate::instruction::FunderInstruction;
use crate::state::{CampaignFunded, FunderState, BPS, CAMPAIGN_SEED, FUNDER_STATE_SEED, VAULT_AUTHORITY_SEED};

pub fn process<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], data: &[u8]) -> ProgramResult {
    let ix = FunderInstruction::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    match ix {
        FunderInstruction::Initialize { treasury_bps } => initialize(program_id, accounts, treasury_bps),
        FunderInstruction::SetKeeper { keeper } => set_keeper(program_id, accounts, Pubkey::new_from_array(keeper)),
        FunderInstruction::SetShares { treasury_bps } => set_shares(program_id, accounts, treasury_bps),
        FunderInstruction::SetSwapProgram { swap_program } => {
            set_swap_program(program_id, accounts, Pubkey::new_from_array(swap_program))
        }
        FunderInstruction::Pause => set_paused(program_id, accounts, true),
        FunderInstruction::Unpause => set_paused(program_id, accounts, false),
        FunderInstruction::SwapAndFund { campaign_id, usdc_amount, min_dwell_out } => {
            swap_and_fund(program_id, accounts, campaign_id, usdc_amount, min_dwell_out)
        }
    }
}

fn funder_state_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[FUNDER_STATE_SEED], program_id)
}

fn load_state(funder_state_ai: &AccountInfo) -> Result<FunderState, ProgramError> {
    let state = FunderState::try_from_slice(&funder_state_ai.data.borrow())?;
    if !state.is_initialized {
        return Err(FunderError::NotInitialized.into());
    }
    Ok(state)
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], treasury_bps: u16) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let funder_state_ai = next_account_info(iter)?;
    let treasury = next_account_info(iter)?;
    let dwell_mint = next_account_info(iter)?;
    let usdc_mint = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if treasury_bps as u64 > BPS {
        return Err(FunderError::BadBps.into());
    }
    let (expected_state, bump) = funder_state_pda(program_id);
    if expected_state != *funder_state_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    if funder_state_ai.data_len() > 0 && !funder_state_ai.data.borrow().iter().all(|b| *b == 0) {
        return Err(FunderError::AlreadyInitialized.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(FunderState::LEN);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            funder_state_ai.key,
            lamports,
            FunderState::LEN as u64,
            program_id,
        ),
        &[payer.clone(), funder_state_ai.clone(), system_program.clone()],
        &[&[FUNDER_STATE_SEED, &[bump]]],
    )?;

    let state = FunderState {
        is_initialized: true,
        owner: *payer.key,
        keeper: Pubkey::default(),
        treasury: *treasury.key,
        dwell_mint: *dwell_mint.key,
        usdc_mint: *usdc_mint.key,
        swap_program: Pubkey::default(),
        treasury_bps,
        is_paused: false,
        total_usdc_spent: 0,
        total_dwell_to_distributor: 0,
        total_dwell_to_treasury: 0,
    };
    state.serialize(&mut &mut funder_state_ai.data.borrow_mut()[..])?;
    msg!("dwell-funder: initialized, treasury_bps={}", treasury_bps);
    Ok(())
}

fn require_owner<'a>(
    program_id: &Pubkey,
    accounts: &'a [AccountInfo<'a>],
) -> Result<(AccountInfo<'a>, FunderState), ProgramError> {
    let iter = &mut accounts.iter();
    let owner = next_account_info(iter)?.clone();
    let funder_state_ai = next_account_info(iter)?.clone();

    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (expected_state, _) = funder_state_pda(program_id);
    if expected_state != *funder_state_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let state = load_state(&funder_state_ai)?;
    if state.owner != *owner.key {
        return Err(FunderError::NotOwner.into());
    }
    Ok((funder_state_ai, state))
}

fn set_keeper<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], keeper: Pubkey) -> ProgramResult {
    let (funder_state_ai, mut state) = require_owner(program_id, accounts)?;
    state.keeper = keeper;
    state.serialize(&mut &mut funder_state_ai.data.borrow_mut()[..])?;
    msg!("dwell-funder: keeper set to {}", keeper);
    Ok(())
}

fn set_swap_program<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], swap_program: Pubkey) -> ProgramResult {
    let (funder_state_ai, mut state) = require_owner(program_id, accounts)?;
    state.swap_program = swap_program;
    state.serialize(&mut &mut funder_state_ai.data.borrow_mut()[..])?;
    msg!("dwell-funder: swap_program set to {}", swap_program);
    Ok(())
}

fn set_shares<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], treasury_bps: u16) -> ProgramResult {
    if treasury_bps as u64 > BPS {
        return Err(FunderError::BadBps.into());
    }
    let (funder_state_ai, mut state) = require_owner(program_id, accounts)?;
    state.treasury_bps = treasury_bps;
    state.serialize(&mut &mut funder_state_ai.data.borrow_mut()[..])?;
    msg!("dwell-funder: treasury_bps set to {}", treasury_bps);
    Ok(())
}

fn set_paused<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], paused: bool) -> ProgramResult {
    let (funder_state_ai, mut state) = require_owner(program_id, accounts)?;
    state.is_paused = paused;
    state.serialize(&mut &mut funder_state_ai.data.borrow_mut()[..])?;
    msg!("dwell-funder: is_paused = {}", paused);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn swap_and_fund(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    campaign_id: [u8; 32],
    usdc_amount: u64,
    min_dwell_out: u64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let keeper = next_account_info(iter)?;
    let funder_state_ai = next_account_info(iter)?;
    let campaign_marker_ai = next_account_info(iter)?;
    let vault_authority_ai = next_account_info(iter)?;
    let funder_usdc_vault = next_account_info(iter)?;
    let funder_dwell_vault = next_account_info(iter)?;
    let mock_swap_program = next_account_info(iter)?;
    let swap_state_ai = next_account_info(iter)?;
    let swap_vault_authority_ai = next_account_info(iter)?;
    let router_dwell_vault = next_account_info(iter)?;
    let router_usdc_vault = next_account_info(iter)?;
    let distributor_dwell_vault = next_account_info(iter)?;
    let treasury_dwell_account = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if !keeper.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (expected_state, _) = funder_state_pda(program_id);
    if expected_state != *funder_state_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let mut state = load_state(funder_state_ai)?;
    if state.keeper == Pubkey::default() {
        return Err(FunderError::KeeperUnset.into());
    }
    if state.keeper != *keeper.key {
        return Err(FunderError::NotKeeper.into());
    }
    if state.is_paused {
        return Err(FunderError::Paused.into());
    }
    if state.swap_program != *mock_swap_program.key {
        return Err(ProgramError::IncorrectProgramId);
    }
    if min_dwell_out == 0 {
        return Err(FunderError::InsufficientOutput.into());
    }

    let (expected_campaign, campaign_bump) =
        Pubkey::find_program_address(&[CAMPAIGN_SEED, &campaign_id], program_id);
    if expected_campaign != *campaign_marker_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    if campaign_marker_ai.lamports() > 0 {
        return Err(FunderError::AlreadyFunded.into());
    }

    let (expected_vault_authority, vault_bump) =
        Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED], program_id);
    if expected_vault_authority != *vault_authority_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let (expected_swap_state, _) = Pubkey::find_program_address(&[SWAP_STATE_SEED], mock_swap_program.key);
    if expected_swap_state != *swap_state_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let (expected_swap_vault_authority, _) =
        Pubkey::find_program_address(&[SWAP_VAULT_AUTHORITY_SEED], mock_swap_program.key);
    if expected_swap_vault_authority != *swap_vault_authority_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }

    // 1. Move the queued tranche to the router — the analogue of the 0x
    //    route pulling `usdcAmount` via an exact, reset-after approval.
    invoke_signed(
        &spl_token::instruction::transfer(
            token_program.key,
            funder_usdc_vault.key,
            router_usdc_vault.key,
            vault_authority_ai.key,
            &[],
            usdc_amount,
        )?,
        &[
            funder_usdc_vault.clone(),
            router_usdc_vault.clone(),
            vault_authority_ai.clone(),
            token_program.clone(),
        ],
        &[&[VAULT_AUTHORITY_SEED, &[vault_bump]]],
    )?;

    // 2. Trust balances, not return data: snapshot before, call the route,
    //    measure what actually moved (mirrors CampaignFunder.swapAndFund).
    let dwell_before = spl_token::state::Account::unpack(&funder_dwell_vault.data.borrow())?.amount;

    let swap_ix_data = SwapInstruction::Swap { usdc_in: usdc_amount };
    let mut data = Vec::new();
    swap_ix_data.serialize(&mut data)?;
    invoke(
        &Instruction {
            program_id: *mock_swap_program.key,
            accounts: vec![
                AccountMeta::new_readonly(*swap_state_ai.key, false),
                AccountMeta::new_readonly(*swap_vault_authority_ai.key, false),
                AccountMeta::new(*router_dwell_vault.key, false),
                AccountMeta::new(*funder_dwell_vault.key, false),
                AccountMeta::new_readonly(*token_program.key, false),
            ],
            data,
        },
        &[
            swap_state_ai.clone(),
            swap_vault_authority_ai.clone(),
            router_dwell_vault.clone(),
            funder_dwell_vault.clone(),
            token_program.clone(),
        ],
    )?;

    let dwell_after = spl_token::state::Account::unpack(&funder_dwell_vault.data.borrow())?.amount;
    let dwell_out = dwell_after
        .checked_sub(dwell_before)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if dwell_out < min_dwell_out {
        return Err(FunderError::InsufficientOutput.into());
    }

    let to_treasury = (dwell_out as u128)
        .checked_mul(state.treasury_bps as u128)
        .and_then(|v| v.checked_div(BPS as u128))
        .ok_or(ProgramError::ArithmeticOverflow)? as u64;
    let to_distributor = dwell_out.checked_sub(to_treasury).ok_or(ProgramError::ArithmeticOverflow)?;

    // 3. Split: treasury leg, then distributor leg — both signed by the
    //    funder's own vault authority PDA.
    invoke_signed(
        &spl_token::instruction::transfer(
            token_program.key,
            funder_dwell_vault.key,
            treasury_dwell_account.key,
            vault_authority_ai.key,
            &[],
            to_treasury,
        )?,
        &[
            funder_dwell_vault.clone(),
            treasury_dwell_account.clone(),
            vault_authority_ai.clone(),
            token_program.clone(),
        ],
        &[&[VAULT_AUTHORITY_SEED, &[vault_bump]]],
    )?;
    invoke_signed(
        &spl_token::instruction::transfer(
            token_program.key,
            funder_dwell_vault.key,
            distributor_dwell_vault.key,
            vault_authority_ai.key,
            &[],
            to_distributor,
        )?,
        &[
            funder_dwell_vault.clone(),
            distributor_dwell_vault.clone(),
            vault_authority_ai.clone(),
            token_program.clone(),
        ],
        &[&[VAULT_AUTHORITY_SEED, &[vault_bump]]],
    )?;

    // 4. Mark the campaign funded — its existence is the AlreadyFunded guard.
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(CampaignFunded::LEN);
    invoke_signed(
        &system_instruction::create_account(
            keeper.key,
            campaign_marker_ai.key,
            lamports,
            CampaignFunded::LEN as u64,
            program_id,
        ),
        &[keeper.clone(), campaign_marker_ai.clone(), system_program.clone()],
        &[&[CAMPAIGN_SEED, &campaign_id, &[campaign_bump]]],
    )?;
    let marker = CampaignFunded {
        is_initialized: true,
        usdc_in: usdc_amount,
        dwell_out,
        to_distributor,
        to_treasury,
    };
    marker.serialize(&mut &mut campaign_marker_ai.data.borrow_mut()[..])?;

    state.total_usdc_spent = state.total_usdc_spent.checked_add(usdc_amount).ok_or(ProgramError::ArithmeticOverflow)?;
    state.total_dwell_to_distributor = state
        .total_dwell_to_distributor
        .checked_add(to_distributor)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    state.total_dwell_to_treasury = state
        .total_dwell_to_treasury
        .checked_add(to_treasury)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    state.serialize(&mut &mut funder_state_ai.data.borrow_mut()[..])?;

    msg!(
        "CampaignFunded campaign_id={:?} usdc_in={} dwell_out={} to_distributor={} to_treasury={}",
        campaign_id,
        usdc_amount,
        dwell_out,
        to_distributor,
        to_treasury
    );
    Ok(())
}
